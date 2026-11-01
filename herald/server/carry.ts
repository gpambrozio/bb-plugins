/**
 * What a thread said that no sentence has covered yet. A tool run is not
 * stopped when a newer event overtakes it, but its sentence is dropped: the
 * thread moved on before it was ready. Without this, what that update said
 * was never read aloud — a review result followed at once by two
 * "Captain, shipshape." turns was lost with them. So each finished turn a
 * tool is writing for is held here per thread, and every later run for that
 * thread is given the updates still held, oldest first, until a sentence for
 * one of them lands (spoken, or the tool's chosen silence).
 *
 * Only finished turns are held: a question, plan or permission a newer event
 * overtook was answered, and an error was followed by a new turn. In memory
 * only, like a sentence being written: a reload drops it.
 */

/** Earlier updates kept per thread at most; the oldest go first. */
export const CARRY_MAX_UPDATES = 4;
/** The earlier updates' text kept per thread at most, together; the oldest go first. */
export const CARRY_MAX_CHARS = 6_000;

export interface CarriedUpdate {
  /** How the prompt names its kind of event. */
  event: string;
  /** What the agent said, already cut to the prompt's bound. */
  output: string;
}

/** What a run is given: the earlier updates still held, and how many older ones the caps let go. */
export interface Carried {
  updates: readonly HeldUpdate[];
  dropped: number;
}

/** A held update, with the number a landed run forgets it by. */
interface HeldUpdate extends CarriedUpdate {
  key: number;
}

const NOTHING: Carried = { updates: [], dropped: 0 };

export class CarriedUpdates {
  private readonly threads = new Map<string, { updates: HeldUpdate[]; dropped: number }>();
  private counter = 0;

  /** The updates a run starting now must cover besides its own. */
  earlier(threadId: string): Carried {
    const held = this.threads.get(threadId);
    return held === undefined ? NOTHING : { updates: [...held.updates], dropped: held.dropped };
  }

  /** An update a run is writing for: held until a run that covers it lands. Returns its key for `landed`. */
  hold(threadId: string, update: CarriedUpdate): number {
    this.counter += 1;
    const held = this.threads.get(threadId) ?? { updates: [], dropped: 0 };
    held.updates.push({ ...update, key: this.counter });
    while (held.updates.length > CARRY_MAX_UPDATES || (held.updates.length > 1 && length(held.updates) > CARRY_MAX_CHARS)) {
      held.updates.shift();
      held.dropped += 1;
    }
    this.threads.set(threadId, held);
    return this.counter;
  }

  /** A run's sentence landed: what it covered — its own update (`own`, null when not held) and `covered` — is forgotten. */
  landed(threadId: string, own: number | null, covered: Carried): void {
    const held = this.threads.get(threadId);
    if (held === undefined) return;
    const gone = new Set(covered.updates.map((update) => update.key));
    if (own !== null) gone.add(own);
    held.updates = held.updates.filter((update) => !gone.has(update.key));
    // Updates go oldest first, so what was pushed out since the run started
    // was what it covered, then its own; only what goes past those was never
    // in its prompt and is still left out.
    const since = held.dropped - covered.dropped;
    held.dropped = Math.max(0, since - covered.updates.length - (own === null ? 0 : 1));
    if (held.updates.length === 0) this.threads.delete(threadId);
  }

  /** The thread was spoken for without a tool, or is gone. */
  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
}

function length(updates: readonly HeldUpdate[]): number {
  return updates.reduce((sum, update) => sum + update.output.length, 0);
}

/**
 * The prompt's output when earlier updates are carried: every update, oldest
 * first, each under its own header, so the tool can tell them apart; with no
 * earlier update, the latest output as it is.
 */
export function combinedOutput(carried: Carried, latest: { event: string; output: string | null }): string | null {
  if (carried.updates.length === 0) return latest.output;
  const total = carried.updates.length + 1;
  const earlier = carried.updates.length === 1 ? "The earlier one was" : `The ${carried.updates.length} earlier ones were`;
  const lines = [`${total} updates from this thread, oldest first. ${earlier} not read aloud: a newer update came before its sentence was ready.`];
  if (carried.dropped > 0) lines.push(`${carried.dropped} older ${carried.dropped === 1 ? "update was" : "updates were"} left out to keep this short.`);
  carried.updates.forEach((update, index) => {
    lines.push("", `[Update ${index + 1} of ${total}: ${update.event}]`, update.output);
  });
  lines.push("", `[Update ${total} of ${total}, the latest: ${latest.event}]`, latest.output ?? "(no output of its own: the event is the update)");
  return lines.join("\n");
}
