/**
 * What the voice model may make happen, enforced here rather than trusted from the model.
 *
 * - **Your words come from the transcript, never from the model.** The call's input transcription is kept
 *   in memory, in the order the audio was committed (`UtteranceLog`). A free-text answer to a question is
 *   what you said after the question was read aloud, word for word; a message or a new thread carries the
 *   words of your request (`requestStart` in `tools.ts`), word for word, as a note for the agent beside the
 *   model's wording.
 * - **A yes is yours.** An approval is sent only once you have said yes after hearing it read back
 *   (`saidYes`), checked on your transcript, not on the model's say-so.
 * - **One send at a time,** and rate limits on sends, so a confused model cannot flood a thread.
 */
import type { Clock } from "./ports";

export interface Utterance {
  itemId: string;
  /** When the audio was committed: the order things were said in. */
  committedAt: number;
  /** The transcript; null until transcription completes. */
  text: string | null;
}

/** How long a read of your words waits for a committed utterance's transcript. */
export const TRANSCRIPT_WAIT_MS = 5_000;
/** How old an utterance may be and still count. */
export const UTTERANCE_MAX_AGE_MS = 3 * 60_000;
/** Utterances kept, for answers, notes and a renewal's recap. */
const KEPT = 40;
/** The most of your words one read returns; the oldest segments go first. */
export const MAX_WORDS_CHARS = 4_000;

export class UtteranceLog {
  private readonly items: Utterance[] = [];
  private waiters: (() => void)[] = [];

  constructor(private readonly clock: Clock) {}

  committed(itemId: string): void {
    if (this.items.some((item) => item.itemId === itemId)) return;
    this.items.push({ itemId, committedAt: this.clock.now(), text: null });
    if (this.items.length > KEPT) this.items.shift();
  }

  transcribed(itemId: string, text: string): void {
    if (!this.items.some((entry) => entry.itemId === itemId)) this.committed(itemId);
    const item = this.items.find((entry) => entry.itemId === itemId);
    if (item !== undefined) item.text = text.trim();
    this.wake();
  }

  /** A transcription that failed counts as empty, so nothing waits on it. */
  failed(itemId: string): void {
    this.transcribed(itemId, "");
  }

  private within(from: number, to: number): Utterance[] {
    const now = this.clock.now();
    return this.items.filter((item) => item.committedAt > from && item.committedAt <= to && now - item.committedAt <= UTTERANCE_MAX_AGE_MS);
  }

  /**
   * Everything you said after `from` and by `to`, word for word, joined in order; null when there is
   * nothing. Waits for transcripts still on their way. Keeps to `MAX_WORDS_CHARS`, dropping the oldest first.
   */
  async between(from: number, to: number): Promise<string | null> {
    await this.until(() => this.within(from, to).every((item) => item.text !== null), TRANSCRIPT_WAIT_MS);
    const said = this.within(from, to)
      .map((item) => item.text ?? "")
      .filter((text) => text !== "");
    const kept: string[] = [];
    let length = -1;
    for (const text of said.reverse()) {
      if (length + 1 + text.length > MAX_WORDS_CHARS) break;
      kept.unshift(text);
      length += 1 + text.length;
    }
    return kept.length === 0 ? null : kept.join(" ");
  }

  /** When the last utterance committed by `to` was committed; null for none. */
  lastCommitBefore(to: number): number | null {
    const committed = this.items.filter((item) => item.committedAt <= to).map((item) => item.committedAt);
    return committed.length === 0 ? null : Math.max(...committed);
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

/** Sounds a transcriber writes for a breath, a cough or a noise rather than words. */
const FILLER = /^(?:u+h+|u+m+|h+m+|m+|m+-?h+m+|a+h+|o+h+|e+r+|h+u+h+|shh+|tsk)$/iu;

/**
 * Whether a transcript is only noise: nothing, punctuation, or filler sounds ("um", "hmm"), so the turn it
 * ended is not answered. Any real word counts as speech.
 */
export function isNoise(text: string | null): boolean {
  if (text === null) return true;
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((word) => word.replace(/^['-]+|['-]+$/gu, ""))
    .filter((word) => word !== "");
  return words.every((word) => FILLER.test(word));
}

const YES = /\b(yes|yeah|yep|yup|approve|approved|allow|allowed|confirm|confirmed|go ahead|do it|send it|sure|ok|okay|correct|affirmative)\b/iu;
const NO = /\b(no|nope|not|don't|dont|do not|cancel|stop|wait|hold on|deny|denied|never|negative)\b/iu;

/**
 * Whether `words` are a plain yes: one of the yes words and none of the no words, so "yes, approve it"
 * passes and "no, don't approve it", "yes, but wait" and "not yet" do not. On your transcript only.
 */
export function saidYes(words: string | null): boolean {
  if (words === null) return false;
  const text = words.replace(/[’']/gu, "'");
  return YES.test(text) && !NO.test(text);
}

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

/** One send at a time: a second while one is out is refused, never queued. */
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
