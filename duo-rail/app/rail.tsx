// The rail: a column of symbol-only buttons in the folded Duo's empty side strip, below the camera.
// Mounted once per window as an app overlay; it draws nothing unless the page has the folded Duo's
// insets (see ../shared/placement.ts).
import {
  experimental_SidebarNavigationIcon as SidebarNavigationIcon,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { forwardRef, useMemo, useRef, type ComponentPropsWithoutRef, type CSSProperties } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
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
import { railPlacement, type RailPlacement } from "../shared/placement";
import { CAMERA_CLEARANCE_SETTING } from "../shared/settings";
import { useCovered } from "./covered";
import { PROBE_STYLE, useViewport } from "./insets";
import { recentThreads } from "./recent";

/** Back, New thread, More. */
export const RAIL_BUTTON_COUNT = 3;

/**
 * Above bb's page (30 on compact screens) and under every layer bb draws over it: the compact sidebar
 * drawer's tap-to-close layer (40), the full-page tool panel (45), toasts (49), and dialogs, sheets
 * and menus (50). So the rail never takes a tap meant for them, and `useCovered` sees them.
 */
const RAIL_Z_INDEX = 39;

export function railStyle(placement: RailPlacement, covered: boolean): CSSProperties {
  return {
    position: "fixed",
    top: placement.top,
    [placement.side]: 0,
    width: placement.width,
    zIndex: RAIL_Z_INDEX,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: placement.gap,
    // The column's gaps let taps through; only the buttons take them.
    pointerEvents: "none",
    // Covered, it fades out but stays in place, so the hit test can tell when it is uncovered.
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
      // A menu trigger passes its own class and style; merged, so the button keeps taking taps.
      className={cn("pointer-events-auto rounded-full p-0 text-foreground/80 active:bg-state-active [&_[data-icon-root]]:size-[22px] [&_svg]:size-[22px]", className)}
      style={{ ...style, width: size, height: size }}
    >
      {children}
    </Button>
  );
});

function MoreMenu({ size }: { size: number }) {
  const navigate = useBbNavigate();
  const { threadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads();
  const recent = useMemo(() => recentThreads(threads, threadId), [threads, threadId]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RailButton label="More" size={size}>
          <Icon name="MoreHorizontal" />
        </RailButton>
      </DropdownMenuTrigger>
      {/* The rail only shows on bb's compact layout, where this menu is a sheet from the bottom. */}
      <DropdownMenuContent>
        {recent.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Recent threads</DropdownMenuLabel>
            {recent.map((thread) => (
              <DropdownMenuItem key={thread.id} onSelect={() => navigate.toThread(thread.id)}>
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                {thread.needsAttention && <span role="img" aria-label="Needs attention" className="size-2 shrink-0 rounded-full bg-primary" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => window.history.forward()}>
          <Icon name="ArrowRight" />
          Forward
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.location.reload()}>
          <Icon name="ArrowReloadHorizontal" />
          Reload bb
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DuoRail() {
  const probe = useRef<HTMLDivElement | null>(null);
  const viewport = useViewport(probe);
  const compact = useIsCompactViewport();
  const settings = useSettings();
  const navigate = useBbNavigate();
  const rail = useRef<HTMLElement | null>(null);
  const placement = railPlacement({
    compact,
    insets: viewport.insets,
    viewportHeight: viewport.height,
    cameraClearance: settings.values?.[CAMERA_CLEARANCE_SETTING],
    buttonCount: RAIL_BUTTON_COUNT,
  });
  const covered = useCovered(rail, placement !== null);
  return (
    <>
      <div ref={probe} aria-hidden style={PROBE_STYLE} data-testid="duo-rail-probe" />
      {placement !== null && (
        <nav
          ref={rail}
          aria-label="Duo rail"
          aria-hidden={covered || undefined}
          data-testid="duo-rail"
          data-side={placement.side}
          data-covered={covered || undefined}
          style={railStyle(placement, covered)}
        >
          <RailButton label="Back" size={placement.buttonSize} onClick={() => window.history.back()}>
            <Icon name="ArrowLeft" />
          </RailButton>
          <RailButton label="New thread" size={placement.buttonSize} onClick={() => navigate.toCompose()}>
            <SidebarNavigationIcon icon={{ kind: "host", name: "new-thread" }} />
          </RailButton>
          <MoreMenu size={placement.buttonSize} />
        </nav>
      )}
    </>
  );
}
