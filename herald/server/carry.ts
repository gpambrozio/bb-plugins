/**
 * What a thread said that no sentence has covered yet. When a newer event
 * overtakes a tool run, the run is stopped and its sentence never lands: the
 * thread moved on before it was ready. Without this, what that update said
 * was never read aloud — a review result followed at once by two
 * "Captain, shipshape." turns was lost with them. So every finished turn is
 * held here per thread **as it arrives**, before any lookup, in arrival
 * order, and each tool run for the thread is given the updates that arrived
 * before its own, oldest first. They stay until a run that covered them lands
 * (a sentence, or the tool's chosen silence).
 *
 * Arrival is the only way in: the hooks' lookups can only take an update
 * back out (`withdraw`, once they know no tool writes for it), so a lookup
 * that answers late can neither reorder updates nor bring one back after the
 * thread was archived or spoken for without a tool (`forget`, `coveredThrough`).
 *
 * Only finished turns are held: a question, plan or permission a newer event
 * overtook was answered, and an error was followed by a new turn. In memory
 * only, like a sentence being written: a reload drops it.
 */

/** Earlier updates a run is given at most; the oldest go first. */
export const CARRY_MAX_UPDATES = 4;
/** The earlier updates' text a run is given at most, together; the oldest go first. */
export const CARRY_MAX_CHARS = 6_000;

export interface CarriedUpdate {
  /** How the prompt names its kind of event. */
  event: string;
  /** What the agent said, already cut to the prompt's bound. */
  output: string;
}

/** What a run is given: the earlier updates still held, and how many older ones the caps let go. */
export interface Carried {
  updates: readonly CarriedUpdate[];
  dropped: number;
}

interface Held extends CarriedUpdate {
  /** Its place in arrival order, across threads. */
  seq: number;
  /** How many older updates the caps let go while this was the oldest held; they were never in a prompt. */
  droppedBefore: number;
}

export class CarriedUpdates {
  private readonly threads = new Map<string, Held[]>();
  private counter = 0;

  /**
   * An event arriving, before any lookup: its place in the thread's order,
   * and its finished turn, when it has one, held from now on.
   */
  arrive(threadId: string, update: CarriedUpdate | null): number {
    this.counter += 1;
    if (update === null) return this.counter;
    const held = this.threads.get(threadId) ?? [];
    held.push({ ...update, seq: this.counter, droppedBefore: 0 });
    // The newest is some run's own update; the caps bound what comes before it.
    while (held.length > CARRY_MAX_UPDATES + 1 || (held.length > 1 && length(held.slice(0, -1)) > CARRY_MAX_CHARS)) {
      const oldest = held.shift() as Held;
      (held[0] as Held).droppedBefore += oldest.droppedBefore + 1;
    }
    this.threads.set(threadId, held);
    return this.counter;
  }

  /** The updates that arrived before `seq`, oldest first: what the run for `seq` covers besides its own. */
  earlier(threadId: string, seq: number): Carried {
    const before = (this.threads.get(threadId) ?? []).filter((update) => update.seq < seq);
    return {
      updates: before.map(({ event, output }) => ({ event, output })),
      dropped: before.reduce((sum, update) => sum + update.droppedBefore, 0),
    };
  }

  /** The run for `seq` landed, or the plain sentence spoke for it: it and everything before it is covered. */
  coveredThrough(threadId: string, seq: number): void {
    const held = this.threads.get(threadId);
    if (held === undefined) return;
    const left = held.filter((update) => update.seq > seq);
    if (left.length === 0) this.threads.delete(threadId);
    else this.threads.set(threadId, left);
  }

  /** Only `seq` itself is out: no tool writes for it, or only its own plain sentence was spoken. */
  withdraw(threadId: string, seq: number): void {
    const held = this.threads.get(threadId);
    const index = held?.findIndex((update) => update.seq === seq) ?? -1;
    if (held === undefined || index < 0) return;
    const [gone] = held.splice(index, 1);
    // What the caps let go before it still went unread; the next one carries the count.
    const next = held[index];
    if (next !== undefined && gone !== undefined) next.droppedBefore += gone.droppedBefore;
    if (held.length === 0) this.threads.delete(threadId);
  }

  /** The thread is gone. */
  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
}

function length(updates: readonly Held[]): number {
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
