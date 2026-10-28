/**
 * When and how the watch runner's queue (`watches.ts`) reaches the first mate.
 *
 * The first mate is asked for afresh on every delivery — by the stored id only — and the note goes
 * only while it is idle. A first mate mid-turn, or none at all, means wait: the runner keeps the queue
 * and tries again on the first mate's next `thread.idle` or the next minute's tick. The one send uses
 * `queue-if-active`, so a turn that starts between the check and the send holds the note rather than
 * being steered into.
 *
 * A first mate that autocompact would compact right now is compacted first, in the same request
 * (`compact-first.ts`).
 *
 * The first mate reads the whole note; the captain sees one line and a chip to the note, saved in the
 * home (`watch-notes.ts`). A note that cannot be saved goes whole, as it did before, rather than not at all.
 */
import { WATCH_NOTES_FOLDER } from "../shared/types";
import { sendCompactingIfDue } from "./compact-first";
import { errorText, type Log } from "./log";
import type { ThreadsPort } from "./ports";
import type { AutoCompactRules } from "./settings";
import type { Store } from "./store";
import { saveWatchNote, watchNoteLine } from "./watch-notes";
import type { DeliveryOutcome, OutgoingNote } from "./watches";

export interface DeliveryDeps {
  threads: ThreadsPort;
  store: Store;
  /** The first mate's home, which is its thread's workspace. */
  home: string;
  log: Log;
  /** Autocompact's rules, so a first mate due for it is compacted before the note. */
  rules: () => Promise<AutoCompactRules>;
  now?: () => Date;
}

export function createDeliver(deps: DeliveryDeps): (note: OutgoingNote) => Promise<DeliveryOutcome> {
  const now = deps.now ?? (() => new Date());
  return async (note) => {
    const id = await deps.store.mateThreadId();
    if (id === null) return "wait";
    const mate = await deps.threads.get(id);
    if (mate === null || mate.status !== "idle") return "wait";
    const compacting = { ...deps, now: () => now().getTime() };
    let file: string;
    try {
      file = await saveWatchNote(deps.home, note.text, now());
    } catch (error) {
      deps.log.warn(`Could not save the watch note, so it goes to the first mate in full: ${errorText(error)}`);
      await sendCompactingIfDue(compacting, mate.id, "queue-if-active", (mode) => deps.threads.send(mate.id, note.text, mode));
      return "sent";
    }
    const shortened = {
      shown: watchNoteLine(note.notes, note.dropped),
      file: { path: `${WATCH_NOTES_FOLDER}/${file}`, label: "full note" },
      hidden: note.text,
    };
    await sendCompactingIfDue(compacting, mate.id, "queue-if-active", (mode) => deps.threads.sendShortened(mate.id, shortened, mode));
    return "sent";
  };
}
