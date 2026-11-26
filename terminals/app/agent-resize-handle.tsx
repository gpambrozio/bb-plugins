/**
 * The edge between the terminal and the agent panel: drag it, or focus it and
 * use the arrow keys (Shift for bigger steps, Home and End for the narrowest
 * and widest), to set the panel's width; double-click it for the default.
 * The width is remembered in this browser once a drag or key press ends.
 * The terminal refits on its own, through its view's ResizeObserver.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import { DEFAULT_AGENT_WIDTH, KEY_STEP, MIN_AGENT_WIDTH, clampAgentWidth, maxAgentWidth, saveAgentWidth } from "./agent-width";

export function AgentResizeHandle({
  width,
  row,
  onWidth,
}: {
  /** The panel's width now. */
  width: number;
  /** The row holding the terminal and the panel, which bounds the width. */
  row: RefObject<HTMLElement | null>;
  onWidth: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null);
  const rowWidth = () => row.current?.clientWidth ?? 0;
  const set = (next: number, save: boolean) => {
    const clamped = clampAgentWidth(next, rowWidth());
    onWidth(clamped);
    if (save) saveAgentWidth(clamped);
    return clamped;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, last: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    // The panel is on the right: moving the edge left widens it.
    current.last = set(current.startWidth + (current.startX - event.clientX), false);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    saveAgentWidth(current.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const next =
      event.key === "ArrowLeft"
        ? width + step
        : event.key === "ArrowRight"
          ? width - step
          : event.key === "Home"
            ? MIN_AGENT_WIDTH
            : event.key === "End"
              ? Number.POSITIVE_INFINITY
              : null;
    if (next === null) return;
    event.preventDefault();
    set(next, true);
  };

  const max = rowWidth() > 0 ? maxAgentWidth(rowWidth()) : undefined;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the agent panel"
      aria-valuenow={width}
      aria-valuemin={MIN_AGENT_WIDTH}
      {...(max === undefined ? {} : { "aria-valuemax": max })}
      tabIndex={0}
      className="group relative z-10 -mr-1 w-2 shrink-0 cursor-col-resize touch-none outline-none"
      data-agent-resize-handle=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => set(DEFAULT_AGENT_WIDTH, true)}
    >
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:w-0.5 group-hover:bg-ring group-focus-visible:w-0.5 group-focus-visible:bg-ring" />
    </div>
  );
}
