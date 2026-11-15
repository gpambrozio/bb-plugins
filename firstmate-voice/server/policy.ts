/**
 * What the voice model may make happen, enforced here rather than trusted from the model.
 *
 * - **The utterance log.** The captain's words come from the call's input transcription, in the order the
 *   audio was committed. A send copies every segment since the last hand-off, joined in order, so a request
 *   turn detection split at a pause goes whole. A hand-off is a boundary: a send, or a voice reply heard to
 *   its end (talked over, it is not one). The model never writes these words; it writes
 *   only its own account beside them. Kept in memory for the session only.
 * - **One send at a time,** and rate limits on sends and brief reads. There is no press: the captain taps
 *   board buttons on the board.
 */
import type { Clock } from "./ports";

// --- The utterance log ------------------------------------------------------------------------------

export interface Utterance {
  itemId: string;
  /** When the audio was committed, the order the captain said things in. */
  committedAt: number;
  /** The transcript; null until transcription completes. */
  text: string | null;
  /** Already sent to the first mate. */
  used: boolean;
}

/** How long a send waits for a committed utterance's transcript. */
export const TRANSCRIPT_WAIT_MS = 5_000;
/** How old an utterance may be and still be sent. */
export const UTTERANCE_MAX_AGE_MS = 3 * 60_000;
/** Utterances kept, for sends and for a renewal's recap. */
const KEPT = 40;
/** The most of the captain's words one send carries: firstmate-crew's limit. The oldest segments go first. */
export const MAX_SEND_CHARS = 4000;

export class UtteranceLog {
  private readonly items: Utterance[] = [];
  private waiters: (() => void)[] = [];
  /** Segments committed up to here were handed over or answered: a send takes only later ones. */
  private boundaryAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly clock: Clock) {}

  committed(itemId: string): void {
    if (this.items.some((item) => item.itemId === itemId)) return;
    this.items.push({ itemId, committedAt: this.clock.now(), text: null, used: false });
    if (this.items.length > KEPT) this.items.shift();
  }

  transcribed(itemId: string, text: string): void {
    let item = this.items.find((entry) => entry.itemId === itemId);
    if (item === undefined) {
      this.committed(itemId);
      item = this.items.find((entry) => entry.itemId === itemId);
    }
    if (item !== undefined) item.text = text.trim();
    this.wake();
  }

  /** A transcription that failed counts as empty, so nothing waits on it. */
  failed(itemId: string): void {
    this.transcribed(itemId, "");
  }

  /**
   * A hand-off: what the captain said up to `at` has been dealt with. A voice reply heard to its end passes
   * the moment that reply started, so a segment said while it played (it was not talked over) stays.
   */
  boundary(at: number): void {
    this.boundaryAt = Math.max(this.boundaryAt, at);
  }

  /** The unused segments after `floor` (a boundary), committed by `before`, oldest first. */
  private eligible(floor: number, before: number): Utterance[] {
    const now = this.clock.now();
    return this.items.filter(
      (item) => item.committedAt > floor && item.committedAt <= before && !item.used && now - item.committedAt <= UTTERANCE_MAX_AGE_MS,
    );
  }

  /**
   * Everything the captain said since the last boundary and by `before`, word for word, joined in order.
   * Waits for transcripts still on their way. Keeps to `MAX_SEND_CHARS`, dropping the oldest segments
   * first. Null when there is nothing to send.
   */
  async sinceBoundary(before: number): Promise<{ text: string; items: Utterance[] } | null> {
    // The boundary is read once, as the send starts: a reply that ends while a transcript is still on its
    // way must not take that transcript out of the send that was already waiting for it.
    const floor = this.boundaryAt;
    await this.until(() => this.eligible(floor, before).every((item) => item.text !== null), TRANSCRIPT_WAIT_MS);
    const said = this.eligible(floor, before).filter((item) => item.text !== null && item.text !== "");
    const items: Utterance[] = [];
    let length = -1;
    for (const item of said.reverse()) {
      const next = length + 1 + (item.text ?? "").length;
      if (next > MAX_SEND_CHARS) break;
      items.unshift(item);
      length = next;
    }
    if (items.length === 0) return null;
    return { text: items.map((item) => item.text).join(" "), items };
  }

  /** Sent: those segments are spent, and so is everything said before them. */
  markUsed(items: readonly Utterance[]): void {
    for (const item of items) {
      item.used = true;
      this.boundary(item.committedAt);
    }
  }

  /** Every transcribed utterance, oldest first, for a renewal's recap. */
  transcripts(): { at: number; text: string }[] {
    return this.items.filter((item) => item.text !== null && item.text !== "").map((item) => ({ at: item.committedAt, text: item.text ?? "" }));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolves once `done()` holds, checked whenever a transcript lands, or after `ms` whatever it says. */
  private until(done: () => boolean, ms: number): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        resolve();
      };
      const timer = this.clock.setTimeout(finish, ms);
      const check = () => {
        if (settled) return;
        if (done()) finish();
        else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }
}

// --- Rate limits -----------------------------------------------------------------------------------

/** At most `limit` uses in any `windowMs`. */
export class RateLimit {
  private readonly uses: number[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a use and answers true, or answers false and records nothing. */
  take(): boolean {
    const now = this.clock.now();
    while (this.uses.length > 0 && now - (this.uses[0] ?? 0) >= this.windowMs) this.uses.shift();
    if (this.uses.length >= this.limit) return false;
    this.uses.push(now);
    return true;
  }
}

/** One send to the first mate at a time: a second while one is out is refused, never queued. */
export class SendGate {
  private busy = false;

  async run<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (this.busy) return { ok: false };
    this.busy = true;
    try {
      return { ok: true, value: await work() };
    } finally {
      this.busy = false;
    }
  }
}
