/**
 * The session toolbar's keyboard controls: "Full screen" (full screen with
 * the keyboard locked to the page) and the "Send keys" menu for the shortcuts
 * the computer in front of the user keeps for itself, whatever the page does.
 * Both act only on a connected session that is not View only.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { KEY_COMBOS } from "./keys";
import { canGoFullScreen, type ScreenSessionSnapshot, type ScreenSessionStore } from "./session-store";

/** Keys macOS keeps on the user's own Mac, whatever a page does. */
export const SYSTEM_KEYS_NOTE = "⌘Tab, ⌘Space, ⌘` and Mission Control stay on this computer: send them from Send keys.";

function canType(session: ScreenSessionSnapshot): boolean {
  return session.stage.kind === "connected" && !session.viewOnly;
}

export function FullScreenButton({
  store,
  session,
  fullscreenTarget,
}: {
  store: ScreenSessionStore;
  session: ScreenSessionSnapshot;
  fullscreenTarget: RefObject<HTMLElement | null>;
}) {
  const supported = canGoFullScreen();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-pressed={session.fullScreen}
      disabled={!supported || !canType(session)}
      onClick={() => {
        const target = fullscreenTarget.current ?? undefined;
        void store.setFullScreen(!session.fullScreen, target);
      }}
    >
      <Icon name={session.fullScreen ? "Minimize2" : "Maximize2"} />
      Full screen
    </Button>
  );
}

export function SendKeysMenu({ store, session }: { store: ScreenSessionStore; session: ScreenSessionSnapshot }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const enabled = canType(session);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  return (
    <div ref={root} className="relative">
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} disabled={!enabled} onClick={() => setOpen((value) => !value)}>
        <Icon name="ChevronDown" />
        Send keys
      </Button>
      {open ? (
        <div role="menu" aria-label="Send keys to the Mac" className="absolute right-0 top-full z-20 mt-1 flex w-64 flex-col rounded-md border border-border bg-card p-1 shadow-lg">
          <button
            type="button"
            role="menuitem"
            className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover"
            onClick={() => {
              setOpen(false);
              store.holdCommandForAppSwitcher();
            }}
          >
            <span>Hold ⌘ and open the app switcher</span>
            <span className="text-xs text-muted-foreground">⌘Tab…</span>
          </button>
          <div className="my-1 border-t border-border" />
          {KEY_COMBOS.map((combo) => (
            <button
              key={combo.id}
              type="button"
              role="menuitem"
              className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover"
              onClick={() => {
                setOpen(false);
                store.sendKeys(combo);
              }}
            >
              <span>{combo.description}</span>
              <span className="text-xs text-muted-foreground">{combo.label}</span>
            </button>
          ))}
          {!canGoFullScreen() ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              This browser can’t hand its own shortcuts (⌘W, ⌘Q, ⌘T…) to the Mac either; Chrome, Edge and bb’s desktop app
              can, with Full screen.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What is going on with the keyboard, and how to get out of it. */
export function KeysNotice({ store, session }: { store: ScreenSessionStore; session: ScreenSessionSnapshot }) {
  const hostName = session.hostName ?? "the Mac";
  if (session.commandHeld) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-1.5 text-xs">
        <span className="flex-1">
          ⌘ is held down on {hostName}. Press Tab to step through the apps, then release ⌘ to switch.
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => store.releaseCommand()}>
          Release ⌘
        </Button>
      </div>
    );
  }
  if (session.fullScreen) {
    return (
      <div role="status" className="border-b border-border bg-card px-4 py-1.5 text-xs">
        Full screen: your keys go to {hostName}. Hold Esc to leave full screen. {SYSTEM_KEYS_NOTE}
      </div>
    );
  }
  return null;
}
