// The plugin's tabs beside a thread, as the panel controller names them.

/** The editor for the thread's actions file (`app/editor.tsx`). */
export const EDITOR_TAB = { id: "edit-actions", context: { kind: "thread" }, availability: "action" } as const;

/** The list of actions, for a bb without the old header slot (`app/actions-panel.tsx`). */
export const LIST_TAB = { id: "actions", context: { kind: "thread" }, availability: "action" } as const;
