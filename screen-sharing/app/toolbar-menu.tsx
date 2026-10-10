/**
 * The session toolbar's menus (Send keys, Clipboard): a ghost button opening
 * a panel drawn inside the page, not bb's portalled dropdown, because a
 * full-screen page hides anything portalled outside it and both menus are
 * meant for full screen too. A press outside closes it, as does the session
 * stopping taking input.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const ITEM_CLASS = "flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover";

export function ToolbarMenu({
  label,
  icon,
  menuLabel,
  enabled,
  onOpen,
  children,
}: {
  label: string;
  icon: string;
  /** The menu's accessible name. */
  menuLabel: string;
  enabled: boolean;
  /** Called as the menu opens. */
  onOpen?: () => void;
  /** The items; each calls `close` when picked. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={open}
        disabled={!enabled}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        <Icon name={icon} />
        {label}
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label={menuLabel}
          className="absolute right-0 top-full z-20 mt-1 flex w-64 max-w-[calc(100vw-2rem)] flex-col rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function ToolbarMenuItem({ onSelect, children }: { onSelect(): void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" className={ITEM_CLASS} onClick={onSelect}>
      {children}
    </button>
  );
}

export function ToolbarMenuCheckboxItem({ checked, onSelect, children }: { checked: boolean; onSelect(): void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className={ITEM_CLASS} onClick={onSelect}>
      {children}
      <span className="flex size-4 shrink-0 items-center justify-center">{checked ? <Icon name="Check" /> : null}</span>
    </button>
  );
}

export function ToolbarMenuSeparator() {
  return <div className="my-1 border-t border-border" />;
}

/** A note in a menu; `prominent` is one step up the type scale, for a note that stands in for the items. */
export function ToolbarMenuNote({ prominent = false, children }: { prominent?: boolean; children: ReactNode }) {
  return <p className={`px-2 py-1.5 text-muted-foreground ${prominent ? "text-sm" : "text-xs"}`}>{children}</p>;
}
