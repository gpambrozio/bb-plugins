/**
 * What the voice model may make happen, enforced here rather than trusted from the model.
 *
 * - **The utterance log.** The captain's words come from the call's input transcription, in the order the
 *   audio was committed. Sends copy them from here: the model names how many of the latest to send and
 *   never writes them. Kept in memory for the session only.
 * - **The two-phase press.** `propose` picks a button and returns a read-back the server wrote; it counts as
 *   read back only once the model's own speech said it. `confirm` then needs the captain's first words after
 *   the read-back to be a short yes with no negation, within 30 s, on a single-use token, at most one press
 *   every 10 s. Firstmate-crew checks the card's etag and refuses tap-only buttons again.
 * - **One send at a time,** and rate limits on sends, presses and brief reads.
 */
import type { Clock } from "./ports";

// --- The utterance log ------------------------------------------------------------------------------

export interface Utterance {
  itemId: string;
  /** When the audio was committed, the order the captain said things in. */
  committedAt: number;
  /** The transcript; null until transcription completes. */
  text: string | null;
  /** Already sent to the first mate, or used as a press confirmation. */
  used: boolean;
}

/** How long a send waits for a committed utterance's transcript. */
export const TRANSCRIPT_WAIT_MS = 5_000;
/** How old an utterance may be and still be sent. */
export const UTTERANCE_MAX_AGE_MS = 3 * 60_000;
/** Utterances kept, for sends and for a renewal's recap. */
const KEPT = 40;

export class UtteranceLog {
  private readonly items: Utterance[] = [];
  private waiters: (() => void)[] = [];

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

  /** The utterances committed up to `before`, newest last, that have words and are unused. */
  private eligible(before: number): Utterance[] {
    const now = this.clock.now();
    return this.items.filter((item) => item.committedAt <= before && !item.used && now - item.committedAt <= UTTERANCE_MAX_AGE_MS);
  }

  /**
   * The captain's latest `count` utterances committed by `before`, word for word, joined. Waits for
   * transcripts still on their way. Null when there are none to send.
   */
  async latest(count: number, before: number): Promise<{ text: string; items: Utterance[] } | null> {
    await this.until(() => this.eligible(before).every((item) => item.text !== null), TRANSCRIPT_WAIT_MS);
    const items = this.eligible(before)
      .filter((item) => item.text !== null && item.text !== "")
      .slice(-count);
    if (items.length === 0) return null;
    return { text: items.map((item) => item.text).join(" "), items };
  }

  /** The first utterance committed after `after`, waiting for its transcript; null when there is none. */
  async firstAfter(after: number): Promise<Utterance | null> {
    const first = () => this.items.find((item) => item.committedAt > after) ?? null;
    await this.until(() => first() === null || first()?.text !== null, TRANSCRIPT_WAIT_MS);
    const item = first();
    return item === null || item.text === null ? null : item;
  }

  markUsed(items: readonly Utterance[]): void {
    for (const item of items) item.used = true;
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

// --- Yes and no ------------------------------------------------------------------------------------

const NEGATIONS = /\b(no|nope|nah|not|don'?t|do not|never|wait|stop|cancel|hold on|hang on|abort|scratch that|negative|wrong|isn'?t|shouldn'?t|actually)\b/iu;
const AFFIRMATIONS = /\b(yes|yeah|yep|yup|aye|confirm(ed)?|do it|go ahead|go for it|please do|press it|affirmative|correct|that'?s right|sure)\b/iu;
/** A yes is short: a longer answer is a new request, not a confirmation. */
const MAX_CONFIRM_WORDS = 8;

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/u).filter(Boolean);
}

/** A short affirmative answer with no negation in it. */
export function isConfirmation(text: string): boolean {
  const said = words(text);
  if (said.length === 0 || said.length > MAX_CONFIRM_WORDS) return false;
  const plain = said.join(" ");
  return AFFIRMATIONS.test(plain) && !NEGATIONS.test(plain);
}

/** Whether the model's own speech said the read-back: most of its words, in any order. */
export function saidReadBack(spoken: string, readBack: string): boolean {
  const expected = new Set(words(readBack).filter((word) => word.length > 2));
  if (expected.size === 0) return false;
  const heard = new Set(words(spoken));
  let found = 0;
  for (const word of expected) if (heard.has(word)) found += 1;
  return found / expected.size >= 0.75;
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

// --- The two-phase press ---------------------------------------------------------------------------

export const CONFIRM_WINDOW_MS = 30_000;
export const PRESS_INTERVAL_MS = 10_000;

export interface Proposal {
  token: string;
  ref: string;
  /** The card or suggestion's etag when it was read, which firstmate-crew checks again on the press. */
  etag: string;
  readBack: string;
  proposedAt: number;
  /** When the model's speech said the read-back; null until it has. */
  readBackAt: number | null;
  used: boolean;
}

export type ConfirmOutcome =
  | { ok: true; proposal: Proposal; confirmation: Utterance }
  | { ok: false; reason: string };

/** Proposals and their confirmations. One proposal is open at a time; a new one replaces it. */
export class PressGuard {
  private current: Proposal | null = null;
  private counter = 0;
  private lastPressAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: Clock,
    private readonly utterances: UtteranceLog,
  ) {}

  propose(ref: string, etag: string, readBack: string): Proposal {
    this.counter += 1;
    this.current = { token: `p${this.counter}-${Math.random().toString(36).slice(2, 8)}`, ref, etag, readBack, proposedAt: this.clock.now(), readBackAt: null, used: false };
    return this.current;
  }

  /** The model finished speaking `transcript`; it marks the open proposal read back if it said it. */
  spoke(transcript: string): void {
    const proposal = this.current;
    if (proposal === null || proposal.used || proposal.readBackAt !== null) return;
    if (saidReadBack(transcript, proposal.readBack)) proposal.readBackAt = this.clock.now();
  }

  /** Drops the open proposal: the captain said no, or something else came up. */
  drop(): void {
    this.current = null;
  }

  /** Checks a confirm against the captain's own words. The token is spent whatever the answer. */
  async confirm(token: string): Promise<ConfirmOutcome> {
    const proposal = this.current;
    if (proposal === null || proposal.token !== token || proposal.used) {
      return { ok: false, reason: "There is no open proposal with that token. Call propose_press first and read its text back." };
    }
    proposal.used = true;
    this.current = null;
    if (proposal.readBackAt === null) {
      return { ok: false, reason: "The read-back was not spoken. Call propose_press again and read its text exactly." };
    }
    if (this.clock.now() - this.lastPressAt < PRESS_INTERVAL_MS) {
      return { ok: false, reason: "Only one press every ten seconds. Ask the captain again in a moment." };
    }
    const answer = await this.utterances.firstAfter(proposal.readBackAt);
    if (answer === null || answer.text === null) {
      return { ok: false, reason: "The captain has not answered the read-back. Ask again, or drop it." };
    }
    if (answer.committedAt - proposal.readBackAt > CONFIRM_WINDOW_MS) {
      return { ok: false, reason: "The captain answered more than thirty seconds after the read-back. Propose it again." };
    }
    if (!isConfirmation(answer.text)) {
      return { ok: false, reason: "The captain's answer was not a plain yes. Nothing was pressed; drop it unless they ask again." };
    }
    this.utterances.markUsed([answer]);
    this.lastPressAt = this.clock.now();
    return { ok: true, proposal, confirmation: answer };
  }
}
