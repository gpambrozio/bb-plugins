/**
 * What the voice model may make happen, enforced here rather than trusted from the model.
 *
 * - **The utterance log.** The captain's words come from the call's input transcription, in the order the
 *   audio was committed. A send copies every segment since the last hand-off, joined in order, so a request
 *   turn detection split at a pause goes whole. A hand-off is a boundary: a send, a press confirmation, or a
 *   voice reply heard to its end (talked over, it is not one). The model never writes these words; it writes
 *   only its own account beside them. Kept in memory for the session only.
 * - **The two-phase press.** `propose` picks a button and returns a read-back the server wrote; it counts as
 *   read back only once the model's own speech said it, whole and in order, and that audio played to its
 *   end, not cut off. `confirm` then needs the captain's first words after the read-back to be a plain yes
 *   and nothing else, within 30 s, on a single-use token, at most one press every 10 s. Firstmate-crew checks the card's etag and refuses tap-only buttons again.
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

  /** The first utterance committed after `after`, waiting for its transcript; null when there is none. */
  async firstAfter(after: number): Promise<Utterance | null> {
    const first = () => this.items.find((item) => item.committedAt > after) ?? null;
    await this.until(() => first() === null || first()?.text !== null, TRANSCRIPT_WAIT_MS);
    const item = first();
    return item === null || item.text === null ? null : item;
  }

  /** Sent, or used to confirm a press: those segments are spent, and so is everything said before them. */
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

// --- Yes and no ------------------------------------------------------------------------------------

/** The words of a text, lowercase, without punctuation; curly apostrophes made straight. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[‘’]/gu, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/u).filter(Boolean);
}

/** Every way the captain may say a plain yes, as whole phrases; longest first so "aye aye" wins over "aye". */
const AFFIRMATIVES: readonly string[][] = [
  "go for it",
  "that's right",
  "aye aye",
  "go ahead",
  "do it",
  "please do",
  "press it",
  "yes",
  "yeah",
  "yep",
  "yup",
  "aye",
  "confirm",
  "confirmed",
  "affirmative",
  "correct",
  "sure",
]
  .map((phrase) => phrase.split(" "))
  .sort((x, y) => y.length - x.length);

/** Politeness around a yes that changes nothing. Anything else in the answer makes it not a plain yes. */
const FILLERS: readonly string[][] = ["thank you", "please", "captain", "sir", "thanks", "ok", "okay", "alright", "oh", "um", "uh"]
  .map((phrase) => phrase.split(" "))
  .sort((x, y) => y.length - x.length);

function startsWith(tokens: readonly string[], at: number, phrase: readonly string[]): boolean {
  return phrase.every((word, i) => tokens[at + i] === word);
}

/**
 * A plain yes: the whole answer is affirmative phrases and politeness, nothing else. "Yes, but use SQLite
 * instead", "yes, and also…", "hold on, yes" and "not yet" are not.
 */
export function isConfirmation(text: string): boolean {
  const tokens = words(text);
  let at = 0;
  let affirmed = false;
  while (at < tokens.length) {
    const yes = AFFIRMATIVES.find((phrase) => startsWith(tokens, at, phrase));
    if (yes !== undefined) {
      affirmed = true;
      at += yes.length;
      continue;
    }
    const filler = FILLERS.find((phrase) => startsWith(tokens, at, phrase));
    if (filler === undefined) return false;
    at += filler.length;
  }
  return affirmed;
}

// --- The read-back ---------------------------------------------------------------------------------

const BREAK = "\u0000";
const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/** Words a read-back may lose or gain in speech without changing what it names. */
const DROPPED = new Set(["number"]);
/** Words before a read-back that turn it into something other than the offer to press. */
const NEGATING = new Set(["not", "don't", "won't", "never", "no", "can't", "cannot", "shouldn't", "wouldn't", "instead", "rather", "except", "unless"]);
/** Words that may follow a read-back in its sentence ("…pull request 42, captain?"). */
const TRAILING = new Set(["captain", "sir"]);
/** How long the lead-in to a read-back may be ("Captain, shall I"), in words. */
const LEAD_IN_MAX = 6;

/** The value of a number word, or null: units, teens and tens; "hundred" and "thousand" are scales. */
function numberWord(token: string): number | null {
  const unit = UNITS.indexOf(token);
  if (unit >= 0) return unit;
  const tens = TENS.indexOf(token);
  return tens >= 2 ? tens * 10 : null;
}

const SCALES: Record<string, number> = { hundred: 100, thousand: 1000 };

/**
 * Numbers said in words, turned into digits: "forty-two", "one hundred twelve", "one hundred and twelve",
 * "a hundred", "one thousand one hundred twelve". An "and" counts only between a scale and more number.
 */
function digitsFor(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    const startsNumber = numberWord(token) !== null || (token === "a" && SCALES[tokens[i + 1] ?? ""] !== undefined);
    if (!startsNumber) {
      out.push(token);
      i += 1;
      continue;
    }
    let total = 0;
    let current = 0;
    let lastWasScale = false;
    while (i < tokens.length) {
      const word = tokens[i] ?? "";
      const value = word === "a" ? 1 : numberWord(word);
      const scale = SCALES[word];
      if (value !== null && !(word === "a" && SCALES[tokens[i + 1] ?? ""] === undefined)) {
        current += value;
        lastWasScale = false;
      } else if (scale === 100) {
        current = (current === 0 ? 1 : current) * 100;
        lastWasScale = true;
      } else if (scale === 1000) {
        total += (current === 0 ? 1 : current) * 1000;
        current = 0;
        lastWasScale = true;
      } else if (word === "and" && lastWasScale && numberWord(tokens[i + 1] ?? "") !== null) {
        lastWasScale = false;
      } else break;
      i += 1;
    }
    out.push(String(total + current));
  }
  return out;
}

/**
 * The tokens of a text for matching a read-back: words, with sentence ends kept as a mark, numbers said in
 * words turned into digits, digit groups joined ("1,112"), and "number" dropped.
 */
function readBackTokens(text: string): string[] {
  const marked = text
    .replace(/(\d),(?=\d{3}\b)/gu, "$1")
    .replace(/[.?!]+(?=["'”’)]*(\s|$))/gu, ` ${BREAK} `)
    .replace(/(\p{L})-(\p{L})/gu, "$1 $2");
  const tokens = marked
    .split(/\s+/u)
    .flatMap((chunk) => (chunk === BREAK ? [BREAK] : words(chunk)))
    .filter((token) => !DROPPED.has(token));
  return digitsFor(tokens);
}

/**
 * Where the expected words appear in order from `start`, skipping sentence marks inside the span (a title
 * may hold a full stop, and speech may add or drop one); the index after the last, or -1.
 */
function matchFrom(heard: readonly string[], start: number, expected: readonly string[]): number {
  let at = start;
  for (const word of expected) {
    while (at > start && heard[at] === BREAK) at += 1;
    if (heard[at] !== word) return -1;
    at += 1;
  }
  return at;
}

/**
 * Whether the model's own speech said the read-back: every word of it, in order, as the end of a sentence,
 * after at most a short lead-in with no negation in it. A different label, a different pull request number
 * or "I won't press…" does not count.
 */
export function saidReadBack(spoken: string, readBack: string): boolean {
  const expected = readBackTokens(readBack).filter((token) => token !== BREAK);
  if (expected.length === 0) return false;
  const heard = readBackTokens(spoken);
  for (let start = 0; start < heard.length; start += 1) {
    let end = matchFrom(heard, start, expected);
    if (end < 0) continue;
    while (TRAILING.has(heard[end] ?? "")) end += 1;
    if (end < heard.length && heard[end] !== BREAK) continue;
    let lead = start;
    while (lead > 0 && heard[lead - 1] !== BREAK) lead -= 1;
    const leadIn = heard.slice(lead, start);
    if (leadIn.length <= LEAD_IN_MAX && !leadIn.some((token) => NEGATING.has(token))) return true;
  }
  return false;
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
  /** The model's speech said the open proposal's read-back, and its audio has not finished yet. */
  private heard = false;

  constructor(
    private readonly clock: Clock,
    private readonly utterances: UtteranceLog,
  ) {}

  propose(ref: string, etag: string, readBack: string): Proposal {
    this.counter += 1;
    this.heard = false;
    this.current = { token: `p${this.counter}-${Math.random().toString(36).slice(2, 8)}`, ref, etag, readBack, proposedAt: this.clock.now(), readBackAt: null, used: false };
    return this.current;
  }

  /** The model's speech said the read-back: it counts once its audio has played to the end (`audioFinished`). */
  spoke(transcript: string): void {
    const proposal = this.current;
    if (proposal === null || proposal.used || proposal.readBackAt !== null) return;
    if (saidReadBack(transcript, proposal.readBack)) this.heard = true;
  }

  /** The reply audio played to its end: a read-back said in it now counts, from this moment. */
  audioFinished(): void {
    if (!this.heard || this.current === null) return;
    this.heard = false;
    this.current.readBackAt = this.clock.now();
  }

  /** The captain talked over the reply: a read-back in it was not heard whole, so it does not count. */
  audioCut(): void {
    this.heard = false;
  }

  /** Drops the open proposal: the captain said no, or something else came up. */
  drop(): void {
    this.current = null;
    this.heard = false;
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
