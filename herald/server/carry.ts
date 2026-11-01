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
 * Whether a tool writes for an update — announced, and the model on — is
 * decided apart from, and usually before, the event's context lookup
 * (`eligible`). A run waits for the earlier decisions (`decided`) and is
 * given only updates decided eligible: a finished turn whose announcement
 * is off must never reach a question's prompt while its context is still
 * being read.
 *
 * Only finished turns are held: a question, plan or permission a newer event
 * overtook was answered, and an error was followed by a new turn. In memory
 * only, like a sentence being written: a reload drops it.
 */

/** Earlier updates a run is given at most; the oldest go first. */
export const CARRY_MAX_UPDATES = 4;
/** The earlier updates' text a run is given at most, together; the oldest go first. */
export const CARRY_MAX_CHARS = 6_000;
/**
 * What memory keeps per thread, decided or not, beyond the caps a run is
 * given within: room for updates whose eligibility is still being read.
 */
const HELD_MAX = 2 * (CARRY_MAX_UPDATES + 1);

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
  /** Which held updates these are, for `covered`. */
  seqs: readonly number[];
}

interface Held extends CarriedUpdate {
  /** Its place in arrival order, across threads. */
  seq: number;
  /** How many older updates the caps let go while this was the oldest held; they were never in a prompt. */
  droppedBefore: number;
  /** Whether a tool writes for it: null until decided. */
  eligible: boolean | null;
  /** Settles once `eligible` is decided. */
  decision: Promise<void>;
}

export class CarriedUpdates {
  private readonly threads = new Map<string, Held[]>();
  private counter = 0;

  /**
   * An event arriving, before any lookup: its place in the thread's order,
   * and its finished turn, when it has one, held from now on. `eligible`
   * says whether a tool writes for it (rejecting counts as no); without it,
   * it is eligible.
   */
  arrive(threadId: string, update: CarriedUpdate | null, eligible?: Promise<boolean>): number {
    this.counter += 1;
    const seq = this.counter;
    if (update === null) return seq;
    const held = this.threads.get(threadId) ?? [];
    const item: Held = { ...update, seq, droppedBefore: 0, eligible: eligible === undefined ? true : null, decision: Promise.resolve() };
    if (eligible !== undefined) {
      item.decision = eligible.then(
        (yes) => this.decide(threadId, item, yes),
        () => this.decide(threadId, item, false),
      );
    }
    held.push(item);
    // Only memory is bounded here; `earlier` applies the caps to what a run is given.
    while (held.length > HELD_MAX) this.drop(held, 0);
    this.threads.set(threadId, held);
    return seq;
  }

  /** Resolves once every update that arrived before `seq` is decided, or after `waitMs`, whichever is first. */
  async decided(threadId: string, seq: number, waitMs: number): Promise<void> {
    const pending = (this.threads.get(threadId) ?? []).filter((update) => update.seq < seq && update.eligible === null).map((update) => update.decision);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }

  /**
   * The eligible updates that arrived before `seq`, oldest first, within the
   * caps: what the run for `seq` covers besides its own, whatever kind of
   * event it is. What the caps let go now is dropped and counted.
   */
  earlier(threadId: string, seq: number): Carried {
    const held = this.threads.get(threadId) ?? [];
    const before = () => held.filter((update) => update.seq < seq && update.eligible === true);
    let given = before();
    while (given.length > CARRY_MAX_UPDATES || (given.length > 1 && length(given) > CARRY_MAX_CHARS)) {
      this.drop(held, held.indexOf(given[0] as Held));
      given = before();
    }
    if (held.length === 0) this.threads.delete(threadId);
    return {
      updates: given.map(({ event, output }) => ({ event, output })),
      // Counted on whatever is held before `seq`, given or not: every one was let go before this run.
      dropped: held.filter((update) => update.seq < seq).reduce((sum, update) => sum + update.droppedBefore, 0),
      seqs: given.map((update) => update.seq),
    };
  }

  /**
   * The run for `own` landed: it and what it was given are covered, and the
   * count of what was let go before it was told.
   */
  covered(threadId: string, own: number, given: Carried): void {
    const held = this.threads.get(threadId);
    if (held === undefined) return;
    const gone = new Set([own, ...given.seqs]);
    const left = held.filter((update) => !gone.has(update.seq));
    for (const update of left) if (update.seq < own) update.droppedBefore = 0;
    if (left.length === 0) this.threads.delete(threadId);
    else this.threads.set(threadId, left);
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

  private decide(threadId: string, item: Held, yes: boolean): void {
    if (yes) item.eligible = true;
    else this.withdraw(threadId, item.seq);
  }

  /**
   * Lets the caps take `held[index]`: counted on the next one held, as it
   * was never in a prompt — unless it was not yet known to be one a tool
   * writes for, which only memory's bound lets go.
   */
  private drop(held: Held[], index: number): void {
    const [gone] = held.splice(index, 1);
    const next = held[index];
    if (gone !== undefined && next !== undefined) next.droppedBefore += gone.droppedBefore + (gone.eligible === true ? 1 : 0);
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
