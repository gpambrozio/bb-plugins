// The rail: a column of symbol-only buttons standing on the bottom of the iPhone Duo's empty side strip,
// under the camera gap, on the folded and the unfolded display alike. Mounted once per window as an app
// overlay; it draws nothing unless the page has the Duo's insets (see ../shared/placement.ts). Which
// buttons it draws, and what they do, is the owner's layout for the display it is on (../shared/layout.ts).
import {
  experimental_SidebarNavigationIcon as SidebarNavigationIcon,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
  useBbContext,
  useBbNavigate,
  useSdk,
  useSettings,
  type PluginBoundThreadAction,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { Fragment, forwardRef, useEffect, useMemo, useRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useIsCompactViewport } from "../components/ui/hooks/use-compact-viewport";
import { Icon } from "../components/ui/icon";
import { cn } from "../lib/utils";
import { displayFor, NEW_THREAD_ICON, type MenuItem, type RailButton as RailButtonConfig } from "../shared/layout";
import { railPlacement, type RailPlacement, type RailSide } from "../shared/placement";
import { CLEARANCE_SETTINGS, DEBUG_SETTING, DEFAULT_CLEARANCES, DEFAULT_SHOW_DEBUG } from "../shared/settings";
import { runAction, type ActionDeps } from "./actions";
import { cancelBbRuns, runBbCommand } from "./bb-command";
import { useCovered } from "./covered";
import { DebugReadout } from "./debug";
import { PROBE_STYLE, useViewport } from "./insets";
import { openThreadTarget } from "./open-thread";
import { recentThreads } from "./recent";
import { useStoredLayout } from "./stored-layout";

/**
 * Above bb's page (30 on compact screens), the compact sidebar drawer's tap-to-close layer (40) and the
 * full-page tool panel a thread's right pane opens as on a compact screen (45), which pads itself out of
 * the strip as the page does; under toasts (49) and dialogs, sheets and menus (50). `useCovered` hides
 * the rail under those, and over the drawer's layer.
 */
const RAIL_Z_INDEX = 46;

export function railStyle(placement: RailPlacement, covered: boolean): CSSProperties {
  return {
    position: "fixed",
    bottom: placement.bottom,
    [placement.side]: 0,
    width: placement.width,
    zIndex: RAIL_Z_INDEX,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: placement.gap,
    // The column's gaps let taps through; only the buttons take them.
    pointerEvents: "none",
    // Covered, it fades out in place (and is inert: taps go to what is under it).
    opacity: covered ? 0 : 1,
    transition: "opacity 150ms ease-out",
  };
}

type RailButtonProps = ComponentPropsWithoutRef<"button"> & { label: string; size: number };

/** A symbol-only button at least Apple's minimum touch target. A ref, for the menu trigger. */
const RailButton = forwardRef<HTMLButtonElement, RailButtonProps>(function RailButton({ label, size, className, style, children, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      aria-label={label}
      {...props}
      // A menu trigger passes its own class and style; merged, so the button keeps taking taps. A disabled
      // button (a thread action with no thread open) still takes the pointer, so a tap on it does nothing
      // rather than fall through to the page under the rail.
      className={cn("pointer-events-auto disabled:pointer-events-auto disabled:cursor-default rounded-full p-0 text-foreground/80 active:bg-state-active [&_[data-icon-root]]:size-[22px] [&_svg]:size-[22px]", className)}
      style={{ ...style, width: size, height: size }}
    >
      {children}
    </Button>
  );
});

/** A button's or a menu item's symbol: a bb icon name, or bb's own New thread glyph. */
export function ActionIcon({ icon }: { icon: string }) {
  if (icon === NEW_THREAD_ICON) return <SidebarNavigationIcon icon={{ kind: "host", name: "new-thread" }} />;
  return <Icon name={icon} />;
}

function useActionDeps(): ActionDeps {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  return useMemo(
    () => ({
      navigate,
      history: window.history,
      reload: () => window.location.reload(),
      runBbCommand: (args) => runBbCommand(sdk, args),
      notify: toast,
    }),
    [navigate, sdk],
  );
}

/** The thread in view, for bb's thread-menu actions; null when none is open. */
function useOpenThread(): PluginThreadActionTarget | null {
  const { threadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads();
  return useMemo(() => openThreadTarget(threads, threadId), [threads, threadId]);
}

/** One of bb's thread-menu actions, evaluated for the open thread; null when it does not apply there. */
function useThreadAction(thread: PluginThreadActionTarget, key: string): PluginBoundThreadAction | null {
  const entries = experimental_useThreadActions(thread, { keys: [key] });
  return entries[0]?.action ?? null;
}

const reportFailure = (label: string) => (error: unknown) =>
  toast.error(`${label} did not work`, { description: error instanceof Error ? error.message : String(error) });

function RecentThreadsSection({ count }: { count: number }) {
  const navigate = useBbNavigate();
  const { threadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads();
  const recent = useMemo(() => recentThreads(threads, threadId, count), [threads, threadId, count]);
  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Recent threads</DropdownMenuLabel>
      {recent.length === 0 && <DropdownMenuItem disabled>No other threads</DropdownMenuItem>}
      {recent.map((thread) => (
        <DropdownMenuItem key={thread.id} onSelect={() => navigate.toThread(thread.id)}>
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {thread.needsAttention && <span role="img" aria-label="Needs attention" className="size-2 shrink-0 rounded-full bg-primary" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** A thread-menu action as menu rows: one row, or a labelled section of its choices. */
function ThreadActionRows({ item, thread }: { item: MenuItem & { action: { kind: "threadAction" } }; thread: PluginThreadActionTarget }) {
  const action = useThreadAction(thread, item.action.key);
  if (action === null) return <DisabledRow item={item} />;
  if (action.choices !== undefined) {
    return (
      <>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{action.choices.heading ?? action.label}</DropdownMenuLabel>
        {action.choices.items.map((choice) => (
          <DropdownMenuItem key={choice.id} disabled={choice.disabled} onSelect={() => void action.run(choice.id).catch(reportFailure(action.label))}>
            <Icon name={choice.icon ?? (choice.selected ? "Check" : "Circle")} />
            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          </DropdownMenuItem>
        ))}
      </>
    );
  }
  return (
    <DropdownMenuItem disabled={action.disabled} onSelect={() => void action.run().catch(reportFailure(action.label))}>
      <ActionIcon icon={item.icon} />
      {action.label}
    </DropdownMenuItem>
  );
}

function DisabledRow({ item }: { item: MenuItem }) {
  return (
    <DropdownMenuItem disabled>
      <ActionIcon icon={item.icon} />
      {item.label}
    </DropdownMenuItem>
  );
}

function MenuRows({ items }: { items: readonly MenuItem[] }) {
  const deps = useActionDeps();
  const thread = useOpenThread();
  // The recent threads are a section of their own, with a separator from their neighbours.
  const isSection = (item: MenuItem) => item.action.kind === "recentThreads";
  return (
    <>
      {items.map((item, index) => {
        const separated = index > 0 && (isSection(item) || isSection(items[index - 1] as MenuItem));
        let row: ReactNode;
        const { action } = item;
        if (action.kind === "recentThreads") row = <RecentThreadsSection count={action.count} />;
        else if (action.kind === "threadAction")
          row = thread === null ? <DisabledRow item={item} /> : <ThreadActionRows item={{ ...item, action }} thread={thread} />;
        else
          row = (
            <DropdownMenuItem onSelect={() => runAction(action, deps)}>
              <ActionIcon icon={item.icon} />
              {item.label}
            </DropdownMenuItem>
          );
        return (
          <Fragment key={item.id}>
            {separated && <DropdownMenuSeparator />}
            {row}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * The side a menu opens to on the wide layout: into the page, away from the strip, its bottom level with
 * its button's, since the rail stands on the bottom of the screen. Compact makes it a sheet.
 */
const menuSide = (side: RailSide) => (side === "right" ? "left" : "right");

function MenuButton({ label, icon, items, size, side }: { label: string; icon: string; items: readonly MenuItem[]; size: number; side: RailSide }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RailButton label={label} size={size}>
          <ActionIcon icon={icon} />
        </RailButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={menuSide(side)} align="end" mobileTitle={label}>
        <MenuRows items={items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThreadActionButton({ button, thread, size, side }: { button: RailButtonConfig; thread: PluginThreadActionTarget; size: number; side: RailSide }) {
  const key = button.action.kind === "threadAction" ? button.action.key : "";
  const action = useThreadAction(thread, key);
  if (action === null) return <RailButton label={button.label} size={size} disabled><ActionIcon icon={button.icon} /></RailButton>;
  if (action.choices !== undefined) {
    const item: MenuItem = { id: button.id, label: button.label, icon: button.icon, action: { kind: "threadAction", key } };
    return <MenuButton label={action.label} icon={button.icon} items={[item]} size={size} side={side} />;
  }
  return (
    <RailButton label={action.label} size={size} disabled={action.disabled} onClick={() => void action.run().catch(reportFailure(action.label))}>
      <ActionIcon icon={button.icon} />
    </RailButton>
  );
}

function RailItem({ button, size, side }: { button: RailButtonConfig; size: number; side: RailSide }) {
  const deps = useActionDeps();
  const thread = useOpenThread();
  const { action } = button;
  if (action.kind === "menu") return <MenuButton label={button.label} icon={button.icon} items={action.items} size={size} side={side} />;
  if (action.kind === "recentThreads") return <MenuButton label={button.label} icon={button.icon} items={[{ ...button, action }]} size={size} side={side} />;
  if (action.kind === "threadAction") {
    if (thread === null) return <RailButton label={button.label} size={size} disabled><ActionIcon icon={button.icon} /></RailButton>;
    return <ThreadActionButton button={button} thread={thread} size={size} side={side} />;
  }
  return (
    <RailButton label={button.label} size={size} onClick={() => runAction(action, deps)}>
      <ActionIcon icon={button.icon} />
    </RailButton>
  );
}

export function DuoRail() {
  const probe = useRef<HTMLDivElement | null>(null);
  const viewport = useViewport(probe);
  const display = displayFor(useIsCompactViewport());
  const settings = useSettings();
  const rail = useRef<HTMLElement | null>(null);
  // Nothing until the layout is read, so a custom rail does not flash the default buttons first.
  const { layout } = useStoredLayout();
  const buttons = layout?.[display].buttons ?? [];
  const placement = railPlacement({
    insets: viewport.insets,
    viewportHeight: viewport.height,
    cameraClearance: settings.values?.[CLEARANCE_SETTINGS[display]],
    defaultClearance: DEFAULT_CLEARANCES[display],
    buttonCount: buttons.length,
  });
  const covered = useCovered(rail, placement);
  // A command still running when the page goes (or this copy of Duo Rail is unloaded) is stopped and its
  // terminal closed; the watchdog on the server stops it anyway if the close does not get out.
  useEffect(() => {
    window.addEventListener("pagehide", cancelBbRuns);
    return () => {
      window.removeEventListener("pagehide", cancelBbRuns);
      cancelBbRuns();
    };
  }, []);
  const showDebug = (settings.values?.[DEBUG_SETTING] ?? DEFAULT_SHOW_DEBUG) === true;
  return (
    <>
      <div ref={probe} aria-hidden style={PROBE_STYLE} data-testid="duo-rail-probe" />
      {placement !== null && (
        <nav
          ref={rail}
          aria-label="Duo rail"
          aria-hidden={covered || undefined}
          inert={covered || undefined}
          data-testid="duo-rail"
          data-side={placement.side}
          data-display={display}
          data-covered={covered || undefined}
          style={railStyle(placement, covered)}
        >
          {buttons.map((button) => (
            <RailItem key={button.id} button={button} size={placement.buttonSize} side={placement.side} />
          ))}
          {showDebug && <DebugReadout probe={probe} display={display} gap={placement.cameraGap} />}
        </nav>
      )}
    </>
  );
}
