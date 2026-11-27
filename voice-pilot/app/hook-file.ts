/**
 * Opening a machine's hook script in bb's own file panel from the settings page. bb's settings page has no
 * file panel (bb 0.50.1: `experimental_openFilePreview` answers false there), so the request is handed to the
 * Voice page, a plugin page with a side panel, which opens it as it mounts. One request per window, dropped
 * after `HOOK_OPEN_WAIT_MS` so a later visit to the Voice page does not open a stale one.
 */
export const HOOK_OPEN_WAIT_MS = 10_000;

export interface HookFileTarget {
  kind: "host";
  hostId: string;
  path: string;
}

export interface HookOpenWanted {
  target: HookFileTarget;
  /** The machine's name, for a note if bb cannot open it there either. */
  machine: string;
  at: number;
}

export interface HookOpenRequest {
  readonly wanted: HookOpenWanted | null;
  ask(target: HookFileTarget, machine: string): void;
  /** The request still fresh, taken off the queue; null when there is none. */
  take(): HookOpenWanted | null;
  subscribe(listener: () => void): () => void;
}

export function makeHookOpenRequest(now: () => number = Date.now): HookOpenRequest {
  let wanted: HookOpenWanted | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    get wanted() {
      return wanted;
    },
    ask(target, machine) {
      wanted = { target, machine, at: now() };
      changed();
    },
    take() {
      const taken = wanted;
      if (taken === null) return null;
      wanted = null;
      changed();
      return now() - taken.at <= HOOK_OPEN_WAIT_MS ? taken : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const hookOpen = makeHookOpenRequest();

/** The id of Voice Pilot's hook editor (`app/hook-editor.tsx`), the file opener Open the script names. */
export const HOOK_EDITOR_ID = "hook-editor";

/** Where each opened script is, by path: bb may not pass the machine to the editor, and the name is for its messages. */
const opened = new Map<string, { hostId: string; machine: string }>();

/** Notes the machine of a script being opened, for its editor. */
export function rememberEditorMachine(target: HookFileTarget, machine: string): void {
  opened.set(target.path, { hostId: target.hostId, machine });
}

/** The machine of a script opened in this window, or undefined. */
export function editorMachine(path: string): { hostId: string; machine: string } | undefined {
  return opened.get(path);
}

/** Opens a hook script in Voice Pilot's editor, in the file panel of the surface `open` belongs to. */
export function openHookEditor(open: (options: { target: HookFileTarget; location: null; opener: string }) => boolean, target: HookFileTarget, machine: string): boolean {
  rememberEditorMachine(target, machine);
  return open({ target, location: null, opener: HOOK_EDITOR_ID });
}

/** What to say when bb could not open the script, so the owner can find it. */
export function hookOpenFailed(wanted: Pick<HookOpenWanted, "target" | "machine">): string {
  return `bb could not open the hook script. It is ${wanted.target.path} on ${wanted.machine}.`;
}
