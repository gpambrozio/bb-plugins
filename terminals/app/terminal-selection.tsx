/**
 * What a selection in a tab's terminal does, as in bb's own terminal: when
 * the mouse lets go of a non-empty selection, an "Add to chat" button floats
 * by the pointer, and — when bb's "Copy on select" setting is on — the text
 * goes to the clipboard with a "Selection copied" toast.
 *
 * Only a selection the user made counts: both happen on the release of a
 * press that started in the terminal, never when the selection changes some
 * other way (output, a program, the terminal clearing it).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Icon } from "@/components/ui/icon";

import type { CopyOnSelectSetting } from "./copy-on-select";
import type { LiveTerminal } from "./live-terminals";

/** Where the button floats, in the terminal view's own coordinates. */
export interface SelectionAnchor {
  x: number;
  y: number;
  /** Below the pointer after a drag downwards, above it otherwise, as bb places it. */
  side: "top" | "bottom";
}

export interface TerminalSelection {
  text: string;
  anchor: SelectionAnchor;
}

/** How far down a drag must end, in pixels, for the button to go below the pointer (bb's threshold). */
const DOWNWARD_DRAG_PX = 4;
/** The button's gap from the pointer and its margin from the view's edges (bb's). */
const SIDE_OFFSET_PX = 6;
const EDGE_PADDING_PX = 8;

export function anchorFor(press: { x: number; y: number } | null, release: { x: number; y: number }, view: DOMRect): SelectionAnchor {
  const side = press !== null && release.y - press.y > DOWNWARD_DRAG_PX ? "bottom" : "top";
  return { x: release.x - view.left, y: release.y - view.top, side };
}

/** Copies `text` the way bb's terminal does, with the same toasts. */
export async function copySelection(text: string): Promise<boolean> {
  const copied = await experimental_copyToClipboard({ text });
  if (copied) toast.success("Selection copied");
  else toast.error("Failed to copy selection");
  return copied;
}

/**
 * Follows the user's selections in `terminal`, whose element is inside
 * `view`. Returns the selection the button is for, and a way to dismiss it.
 */
export function useTerminalSelection(
  terminal: LiveTerminal | null,
  view: RefObject<HTMLElement | null>,
  copyOnSelect: CopyOnSelectSetting,
  copy: (text: string) => Promise<unknown> = copySelection,
): { selection: TerminalSelection | null; dismiss: () => void; onPointerDown: (event: React.PointerEvent) => void } {
  const [selection, setSelection] = useState<TerminalSelection | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const pressing = useRef(false);
  /** What was last reported, so releasing over the same selection again does not copy it twice. */
  const lastReported = useRef("");

  const dismiss = useCallback(() => setSelection(null), []);

  const report = useCallback(
    (anchor: SelectionAnchor) => {
      if (terminal === null) return;
      const text = terminal.selection();
      const repeated = text === lastReported.current;
      lastReported.current = text;
      if (text.trim() === "") {
        setSelection(null);
        return;
      }
      setSelection({ text, anchor });
      if (repeated) return;
      void copyOnSelect.resolve().then((enabled) => {
        // Still the selection the user made: a new press or a cleared selection cancels it.
        if (enabled && lastReported.current === text && terminal.selection() === text) void copy(text);
      });
    },
    [terminal, copyOnSelect, copy],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      pressing.current = true;
      press.current = { x: event.clientX, y: event.clientY };
      setSelection(null);
      // The setting may have changed in Settings since the last selection.
      void copyOnSelect.refresh();
    },
    [copyOnSelect],
  );

  useEffect(() => {
    if (terminal === null) return;
    let frame: number | null = null;
    const release = (event: PointerEvent) => {
      if (!pressing.current || event.button !== 0) return;
      pressing.current = false;
      const element = view.current;
      if (element === null) return;
      const anchor = anchorFor(press.current, { x: event.clientX, y: event.clientY }, element.getBoundingClientRect());
      press.current = null;
      // xterm settles the selection on the same release; read it once it has.
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        report(anchor);
      });
    };
    const cancel = () => {
      pressing.current = false;
      press.current = null;
    };
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", cancel);
    const offSelection = terminal.onSelectionChange(() => {
      if (pressing.current) return;
      // Cleared by a click, typing or the program: the button has nothing left to add.
      if (terminal.selection().trim() === "") {
        lastReported.current = "";
        setSelection(null);
      }
    });
    // The selection moves with the text; the button would float by nothing.
    const offScroll = terminal.onScroll(() => setSelection(null));
    const onResize = () => setSelection(null);
    window.addEventListener("resize", onResize);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", cancel);
      offSelection();
      offScroll();
      window.removeEventListener("resize", onResize);
    };
  }, [terminal, view, report]);

  return { selection, dismiss, onPointerDown };
}

/** bb's selection menu: the popover chrome and its one action's button. */
const MENU_CLASS =
  "pointer-events-auto absolute z-50 flex w-auto items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md outline-none animate-in fade-in-0 zoom-in-95";
const ACTION_CLASS =
  "inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring select-none max-md:pointer-coarse:min-h-7 max-md:pointer-coarse:px-2 max-md:pointer-coarse:py-1";

/**
 * The floating "Add to chat" button, centred on the pointer and kept inside
 * the view, above or below it as bb's own is.
 */
export function SelectionMenu({ anchor, onAddToChat }: { anchor: SelectionAnchor; onAddToChat: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; side: SelectionAnchor["side"] }>({ left: anchor.x, side: anchor.side });

  useLayoutEffect(() => {
    const element = menu.current;
    const bounds = element?.offsetParent;
    if (element === null || !(bounds instanceof HTMLElement)) {
      setPlacement({ left: anchor.x, side: anchor.side });
      return;
    }
    const half = element.offsetWidth / 2;
    const min = EDGE_PADDING_PX + half;
    const max = bounds.clientWidth - EDGE_PADDING_PX - half;
    const left = max < min ? bounds.clientWidth / 2 : Math.min(Math.max(anchor.x, min), max);
    // On the other side when the wanted one has no room, as a popover flips.
    const height = element.offsetHeight + SIDE_OFFSET_PX + EDGE_PADDING_PX;
    let side = anchor.side;
    if (side === "top" && anchor.y - height < 0) side = "bottom";
    else if (side === "bottom" && anchor.y + height > bounds.clientHeight) side = "top";
    setPlacement({ left, side });
  }, [anchor.x, anchor.y, anchor.side]);

  return (
    <div
      ref={menu}
      role="toolbar"
      aria-label="Selection"
      className={MENU_CLASS}
      style={{
        left: placement.left,
        top: placement.side === "bottom" ? anchor.y + SIDE_OFFSET_PX : anchor.y - SIDE_OFFSET_PX,
        transform: placement.side === "bottom" ? "translateX(-50%)" : "translate(-50%, -100%)",
      }}
    >
      <button
        type="button"
        className={ACTION_CLASS}
        // Keeps the terminal's focus and selection until the click lands.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAddToChat}
      >
        <Icon name="MessageSquarePlus" className="size-3.5 text-muted-foreground" aria-hidden="true" />
        Add to chat
      </button>
    </div>
  );
}
