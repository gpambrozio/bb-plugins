/**
 * Text a card shows at most three lines of (`line-clamp-3`), so one long title or hold never fills a column. When the text
 * runs past its lines, a "Show more" button under it opens the rest in place and "Show less" folds it again;
 * text that fits shows no button. Whether it runs past is measured, not guessed from its length, so the
 * button follows the card's width — a phone's narrow column folds sooner than a desktop's.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";

export function ClampedText({
  text,
  label,
  className,
  children,
}: {
  /** The whole text, measured and offered as the folded text's tooltip. */
  text: string;
  /** What the text is, for the button's accessible name: "Show all of the title". */
  label: string;
  className?: string;
  /** What to draw instead of the bare text (a bold lead-in, say); `text` still decides the measuring. */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || open) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div className="flex flex-col items-start gap-0.5">
      <div
        ref={box}
        className={cn("w-full [overflow-wrap:anywhere]", open ? null : "line-clamp-3", className)}
        title={!open && overflows ? text : undefined}
      >
        {children ?? text}
      </div>
      {open || overflows ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          aria-expanded={open}
          aria-label={open ? `Show less of the ${label}` : `Show all of the ${label}`}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
