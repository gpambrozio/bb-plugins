/**
 * The `voice.v1` brief and cards: what FirstMate voice knows of the fleet, built from `loadFleet` and the
 * first mate's last reply.
 *
 * - **Speakable.** Pull request URLs become "web #42", other URLs "a link on example.com", `@thread:`
 *   mentions the thread's title; thread ids, Markdown marks and line breaks go.
 * - **Untrusted and cut.** Anything a worker or the first mate wrote is marked untrusted and cut to its head
 *   and tail, so a closing status line survives a long message.
 * - **Refs, not prompts.** Cards are `c1`, their buttons `c1.a1`, suggestions `s1`. A ref names the same card
 *   for the life of the plugin, whatever column it moves to; the prompts stay here.
 * - **Tap-only buttons.** A button whose label or prompt reads as a merge, something destructive or
 *   irreversible, publishing, credentials or settings can only be pressed on the board (`tapOnlyReason`).
 */
import { createHash } from "node:crypto";

import { STATUS_WORDS, cardSubject } from "../app/format";
import type { Fleet, FleetCard, Suggestion, ThreadStatus } from "../shared/types";
import type { UntrustedText, VoiceAction, VoiceBrief, VoiceCard, VoiceCardBrief, VoicePressable } from "../shared/voice";

// --- Speakable text --------------------------------------------------------------------------------

/** A GitHub pull request or issue, as it is said: "web #42". Null for any other address. */
export function spokenPr(url: string | null): string | null {
  if (url === null) return null;
  const match = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/([^/\s]+)\/(?:pull|issues)\/(\d+)/iu.exec(url);
  return match === null ? null : `${match[1]} #${match[2]}`;
}

/** "web #42" read out in full: "web pull request 42". */
function prInWords(pr: string): string {
  return pr.replace(/ #(\d+)$/u, " pull request $1");
}

/**
 * Text as the voice may say it: URLs and thread references replaced, Markdown marks and line breaks gone.
 * `titles` names threads by id, for `@thread:` mentions.
 */
export function speakable(text: string, titles: ReadonlyMap<string, string> = new Map()): string {
  return (
    text
      // @thread:<id> and @thread:<id>#msg=<n>, bb's links to a thread or one of its messages.
      .replace(/@thread:(thr_[A-Za-z0-9_-]+)(?:#msg=\d+)?/gu, (_whole, id: string) => {
        const title = titles.get(id);
        return title === undefined ? "a worker's thread" : `"${title}"`;
      })
      // [label](url) keeps its label.
      .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)\s]+\)/gu, "$1")
      // A sentence's closing punctuation is not part of the address.
      .replace(/https?:\/\/[^\s)>\]]*[^\s)>\].,;:!?'"]/giu, (url) => {
        const pr = spokenPr(url);
        if (pr !== null) return pr;
        try {
          return `a link on ${new URL(url).hostname.replace(/^www\./u, "")}`;
        } catch {
          return "a link";
        }
      })
      .replace(/\bthr_[A-Za-z0-9_-]+\b/gu, "a thread")
      .replace(/```[\s\S]*?```/gu, " (code left out) ")
      .replace(/[*_`~]+/gu, "")
      .replace(/^\s{0,3}(?:#{1,6}|>)\s*/gmu, "")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/** The text cut to its first `head` and last `tail` characters, at word boundaries, marked untrusted. */
export function headAndTail(text: string, head: number, tail: number): UntrustedText {
  if (text.length <= head + tail) return { untrusted: true, head: text, tail: "", chars: text.length };
  const start = text.slice(0, head);
  const cutStart = start.lastIndexOf(" ") > head / 2 ? start.slice(0, start.lastIndexOf(" ")) : start;
  if (tail === 0) return { untrusted: true, head: `${cutStart} …`, tail: "", chars: text.length };
  const end = text.slice(-tail);
  const cutEnd = end.indexOf(" ") !== -1 && end.indexOf(" ") < tail / 2 ? end.slice(end.indexOf(" ") + 1) : end;
  return { untrusted: true, head: `${cutStart} …`, tail: `… ${cutEnd}`, chars: text.length };
}

/** Speakable, cut and marked untrusted, in one step. */
export function untrusted(text: string, head: number, tail: number, titles?: ReadonlyMap<string, string>): UntrustedText {
  return headAndTail(speakable(text, titles), head, tail);
}

// --- Tap-only buttons ------------------------------------------------------------------------------

/**
 * What the voice never presses in phase 1, even after a read-back and a spoken yes: a misheard word must
 * not merge, destroy, publish or change credentials or settings. Matched on the label and the prompt, as
 * whole words, so a wide net errs towards the board.
 */
const TAP_ONLY: readonly { reason: string; pattern: RegExp }[] = [
  { reason: "a merge", pattern: /\b(merg\w*|land|landing|squash\w*|ship it|fast[- ]?forward\w*|ff-only|cherry[- ]?pick\w*)\b/iu },
  {
    reason: "destructive or irreversible",
    pattern:
      /\b(delet\w*|remov\w*|discard\w*|drop\w*|destroy\w*|wip(e|es|ed|ing)|purg\w*|reset\w*|revert\w*|roll ?back\w*|force\w*|archiv\w*|clos(e|es|ed|ing)|abandon\w*|kill\w*|end (it|the|this|that)|stop the worker|retire\w*|clean\w*|eras\w*|nuk\w*|prun\w*|truncat\w*|overwrit\w*|uninstall\w*|wipe ?out|throw away|rm|rmdir|unlink\w*|rewrit\w* (the )?history|hard reset|--hard|shred\w*|format the|mkfs|dd|empty|emptie\w*|clear(s|ed|ing)? (out|all|the)|wipe\w*)\b/iu,
  },
  { reason: "publishing", pattern: /\b(publish\w*|releas\w*|deploy\w*|tag(s|ged|ging)?|push\w*|announc\w*|tweet\w*|e-?mail\w*)\b/iu },
  { reason: "credentials", pattern: /\b(credential\w*|secret\w*|tokens?|password\w*|passphrase\w*|api[ -]?keys?|ssh[ -]?keys?|log ?in|sign ?in|auth\w*)\b/iu },
  { reason: "settings", pattern: /\b(setting\w*|config\w*|permission\w*|approv\w*|yolo|sudo|chmod|chown)\b/iu },
];

/**
 * A prompt that carries a command to run: the read-back names only the label, so what the command does is
 * not what the captain heard. Checked with links taken out, so a URL's slashes and dashes do not count.
 */
const COMMAND: readonly RegExp[] = [
  /`/u,
  /(\|\||&&|\$\(|>>|(^|\s)[|<>](\s|$)|;\s*\w)/u,
  /(^|\s)--?[a-z][\w-]*/iu,
  /\b(git|gh|rm|mv|cp|dd|npm|npx|yarn|pnpm|bun|bb|docker|kubectl|curl|wget|ssh|scp|rsync|xargs|sed|awk|bash|zsh|sh|python3?|perl|ruby|osascript|launchctl|brew|terraform|psql|mysql|sqlite3)\s+\S/iu,
];

/**
 * What a voice press may ask for, the fail-closed side: the whole prompt must be one known operation, said
 * as one clause. A second clause ("…, then fast-forward main"), a sentence break or a joining word means a
 * compound request whose later parts this list never vetted, so it stays a tap on the board, as does any
 * prompt that opens with no known operation. Each operation is decided by its opening words.
 */
const OPERATIONS: readonly RegExp[] = [
  // A question or a report: the first mate answers, nothing changes.
  /^(what|what's|how|why|which|when|where|who|is|are|was|were|does|do|did|has|have|can|could|should|will)\b.*\?$/u,
  /^(tell me|report|summari[sz]e|explain|describe|show me|list|give me)\b/u,
  // Reading and reviewing.
  /^(check|look at|look into|investigate|research|review|read|plan)\b/u,
  /^run a review loop on\b/u,
  /^(run|rerun|re-run) (the )?(tests?|test suite|checks?|gate|ci)\b/u,
  /^retry\b/u,
  // Waiting and choosing.
  /^(leave|keep)\b.*\bopen\b/u,
  /^(hold off on|hold|wait for|wait|pause)\b/u,
  /^(use|pick|choose|go with|prefer)\b/u,
  // Ordinary work in a crewmate's own checkout.
  /^(fix|start work on|start|implement|add|write)\b/u,
];

/** Words that join a second request onto the first. */
const JOINERS =
  /\b(then|and|also|afterwards|after|before|next|plus|but|or|while|once|if|unless|so|by|via|using|instead|except|finally|meanwhile)\b/u;

/** A tail the first mate's prompts may end with that adds no request. */
const HARMLESS_TAIL = /(,?\s*and do nothing else|\.\s*nothing else)\s*[.!]?$/u;

/** A prompt longer than this is not one the captain heard enough of to vouch for. */
const PROMPT_MAX = 600;

/** Whether the prompt is one known operation, whole, with nothing joined on. */
export function knownOperation(prompt: string): boolean {
  if (prompt.length > PROMPT_MAX) return false;
  let text = prompt
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/https?:\/\/\S+/gu, "url")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(HARMLESS_TAIL, "")
    .replace(/[.!]$/u, "")
    .trim();
  if (text === "") return false;
  const question = text.endsWith("?");
  if (question) text = text.slice(0, -1);
  // A sentence break or a clause mark inside is a second request.
  if (/[.!?;:](\s|$)|\n/u.test(text)) return false;
  if (JOINERS.test(text.replace(/\bonce (more|again)\b/gu, "again"))) return false;
  const whole = question ? `${text}?` : text;
  return OPERATIONS.some((operation) => operation.test(whole));
}

/** Why the button can only be pressed on the board, or null when the voice may press it after a yes. */
export function tapOnlyReason(label: string, prompt: string): string | null {
  const text = `${label}\n${prompt}`;
  const listed = TAP_ONLY.find(({ pattern }) => pattern.test(text))?.reason;
  if (listed !== undefined) return listed;
  const prose = text.replace(/https?:\/\/\S+/giu, " ");
  if (COMMAND.some((pattern) => pattern.test(prose))) return "a command to run";
  if (!knownOperation(prompt)) return "not known to be safe";
  return null;
}

// --- Refs and etags --------------------------------------------------------------------------------

/** A short hash of a JSON value: changes whenever the value does. */
export function etagOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/** What a card is, across columns: its task once it has one, else its board key. */
function cardIdentity(card: FleetCard): string {
  return card.taskId === null ? `key:${card.key}` : `task:${card.taskId}`;
}

function suggestionIdentity(suggestion: Suggestion): string {
  return `${suggestion.label}\n${suggestion.prompt}`;
}

/**
 * Refs handed out for the life of the plugin: a card keeps its `c` number and a suggestion its `s` number
 * whatever else changes. The maps grow by one entry per card ever seen, which a fleet's life keeps small.
 */
export class VoiceRefs {
  private readonly cards = new Map<string, string>();
  private readonly suggestions = new Map<string, string>();

  card(card: FleetCard): string {
    const identity = cardIdentity(card);
    let ref = this.cards.get(identity);
    if (ref === undefined) {
      ref = `c${this.cards.size + 1}`;
      this.cards.set(identity, ref);
    }
    return ref;
  }

  suggestion(suggestion: Suggestion): string {
    const identity = suggestionIdentity(suggestion);
    let ref = this.suggestions.get(identity);
    if (ref === undefined) {
      ref = `s${this.suggestions.size + 1}`;
      this.suggestions.set(identity, ref);
    }
    return ref;
  }
}

// --- The brief -------------------------------------------------------------------------------------

/** What the brief needs of the first mate beyond the fleet. */
export interface MateVoiceState {
  status: ThreadStatus;
  waiting: boolean;
  /** Its last reply, as written; null when it has none. */
  reply: string | null;
  /** When its last turn ended, epoch milliseconds; null when none has. */
  repliedAt: number | null;
}

/** Thread titles by id, for `@thread:` mentions in what the voice is given. */
export function threadTitles(fleet: Fleet): Map<string, string> {
  const titles = new Map<string, string>();
  for (const card of fleet.cards) {
    if (card.crew !== null) titles.set(card.crew.threadId, card.title);
  }
  return titles;
}

const BRIEF_WORD = { head: 200, tail: 120 } as const;
const BRIEF_REPLY = { head: 400, tail: 200 } as const;
const CARD_WORD = { head: 900, tail: 500 } as const;
/** The voice's `get_first_mate_reply`, and what an announcement of a reply is made from. */
export const REPLY_CUT = { head: 3000, tail: 1000 } as const;
const QUEUED_SHOWN = 5;
const LANDED_SHOWN = 3;
const PER_COLUMN = 12;

function actionsOf(card: FleetCard, ref: string): VoiceAction[] {
  return (card.backlog?.actions ?? []).map((action, index) => ({
    ref: `${ref}.a${index + 1}`,
    label: action.label,
    tapOnly: tapOnlyReason(action.label, action.prompt),
  }));
}

function lastWord(card: FleetCard, cut: { head: number; tail: number }, titles: ReadonlyMap<string, string>) {
  return card.report === null ? null : { state: card.report.state, text: untrusted(card.report.text, cut.head, cut.tail, titles) };
}

function briefCard(card: FleetCard, refs: VoiceRefs, titles: ReadonlyMap<string, string>): VoiceCardBrief {
  const ref = refs.card(card);
  return {
    ref,
    title: card.title,
    project: card.project,
    kind: card.kind,
    column: card.column,
    pr: spokenPr(card.url),
    hold: card.backlog?.hold === null || card.backlog?.hold === undefined ? null : speakable(card.backlog.hold, titles),
    lastWord: lastWord(card, BRIEF_WORD, titles),
    actions: actionsOf(card, ref),
    blockedBy: card.backlog?.blockedBy ?? null,
    since: card.backlog?.since ?? null,
  };
}

/** The whole brief: the first mate, the captain's calls, the crew by column, the queue, landings, suggestions and failing watches. */
export function buildVoiceBrief(fleet: Fleet, mate: MateVoiceState | null, refs: VoiceRefs, now: number): VoiceBrief {
  const titles = threadTitles(fleet);
  const live = fleet.cards.filter((card) => card.column !== "done");
  const calls = live.filter((card) => card.backlog?.hold != null);
  const column = (id: FleetCard["column"]) =>
    live
      .filter((card) => card.column === id && card.backlog?.hold == null)
      .slice(0, PER_COLUMN)
      .map((card) => briefCard(card, refs, titles));
  const queued = live.filter((card) => card.column === "queued" && card.backlog?.hold == null);
  const body: Omit<VoiceBrief, "at" | "etag"> = {
    v: 1,
    firstMate:
      mate === null
        ? null
        : {
            status: STATUS_WORDS[mate.status],
            waiting: mate.waiting,
            lastReply: mate.reply === null ? null : untrusted(mate.reply, BRIEF_REPLY.head, BRIEF_REPLY.tail, titles),
            repliedAt: mate.repliedAt === null ? null : new Date(mate.repliedAt).toISOString(),
          },
    captainsCall: calls.map((card) => briefCard(card, refs, titles)),
    working: column("working"),
    blocked: column("blocked"),
    failed: column("failed"),
    parked: column("parked"),
    idle: column("idle"),
    queued: queued.slice(0, QUEUED_SHOWN).map((card) => briefCard(card, refs, titles)),
    queuedMore: Math.max(0, queued.length - QUEUED_SHOWN),
    landed: fleet.cards
      .filter((card) => card.column === "done")
      .slice(0, LANDED_SHOWN)
      .map((card) => ({ title: card.title, outcome: card.backlog?.outcome ?? null })),
    suggestions: fleet.suggestions.map((suggestion) => ({
      ref: refs.suggestion(suggestion),
      label: suggestion.label,
      tapOnly: tapOnlyReason(suggestion.label, suggestion.prompt),
    })),
    watches: {
      failing: fleet.watches
        .filter((watch) => watch.lastResult === "failed")
        .map((watch) => ({ name: watch.name, error: watch.lastError === null ? null : untrusted(watch.lastError, 160, 0).head })),
    },
  };
  return { ...body, at: new Date(now).toISOString(), etag: etagOf(body) };
}

// --- One card in detail ----------------------------------------------------------------------------

/** A button resolved from a ref: its card or suggestion, and the prompt the board's button sends. */
export interface ResolvedButton {
  ref: string;
  label: string;
  prompt: string;
  card: FleetCard | null;
  suggestion: Suggestion | null;
}

/** The sentence the voice reads back before a press, written from the board, never by the model. */
export function readBack(label: string, card: FleetCard | null): string {
  if (card === null) return `Press the suggestion "${label}"?`;
  const pr = spokenPr(card.url);
  return `Press "${label}" on ${card.title}${pr === null ? "" : `, ${prInWords(pr)}`}?`;
}

/** The fleet's card for a `c` ref, or null. */
export function findCard(fleet: Fleet, refs: VoiceRefs, ref: string): FleetCard | null {
  return fleet.cards.find((card) => refs.card(card) === ref) ?? null;
}

/** The fleet's suggestion for an `s` ref, or null. */
export function findSuggestion(fleet: Fleet, refs: VoiceRefs, ref: string): Suggestion | null {
  return fleet.suggestions.find((suggestion) => refs.suggestion(suggestion) === ref) ?? null;
}

/** A card's or a suggestion's detail for `voice.v1.card`, with its etag; null for an unknown ref. */
export function voiceCard(fleet: Fleet, refs: VoiceRefs, ref: string): VoiceCard | null {
  const titles = threadTitles(fleet);
  if (/^c\d+$/u.test(ref)) {
    const card = findCard(fleet, refs, ref);
    if (card === null) return null;
    const pressable: VoicePressable[] = actionsOf(card, ref).map((action) => ({ ...action, readBack: readBack(action.label, card) }));
    const body = {
      ref,
      kind: "card" as const,
      title: card.title,
      project: card.project,
      column: card.column,
      pr: spokenPr(card.url),
      hold: card.backlog?.hold == null ? null : speakable(card.backlog.hold, titles),
      lastWord: lastWord(card, CARD_WORD, titles),
      pressable,
    };
    // The prompts are in the etag, so a button rewritten under the same label is a change.
    return { ...body, etag: etagOf({ body, prompts: card.backlog?.actions ?? [], subject: cardSubject(card) }) };
  }
  if (/^s\d+$/u.test(ref)) {
    const suggestion = findSuggestion(fleet, refs, ref);
    if (suggestion === null) return null;
    const body = {
      ref,
      kind: "suggestion" as const,
      title: suggestion.label,
      project: null,
      column: null,
      pr: null,
      hold: null,
      lastWord: null,
      pressable: [{ ref, label: suggestion.label, tapOnly: tapOnlyReason(suggestion.label, suggestion.prompt), readBack: readBack(suggestion.label, null) }],
    };
    return { ...body, etag: etagOf({ body, prompt: suggestion.prompt }) };
  }
  return null;
}

/** The card ref a button ref belongs to: `c3` for `c3.a1`, the ref itself for a suggestion. */
export function ownerRef(ref: string): string | null {
  const action = /^(c\d+)\.a\d+$/u.exec(ref);
  if (action !== null) return action[1] ?? null;
  return /^s\d+$/u.test(ref) ? ref : null;
}

/** The button a press names, with its prompt; null when the ref names none. */
export function resolveButton(fleet: Fleet, refs: VoiceRefs, ref: string): ResolvedButton | null {
  const action = /^(c\d+)\.a(\d+)$/u.exec(ref);
  if (action !== null) {
    const card = findCard(fleet, refs, action[1] ?? "");
    const picked = card?.backlog?.actions[Number(action[2]) - 1];
    if (card === null || picked === undefined) return null;
    return { ref, label: picked.label, prompt: picked.prompt, card, suggestion: null };
  }
  if (/^s\d+$/u.test(ref)) {
    const suggestion = findSuggestion(fleet, refs, ref);
    return suggestion === null ? null : { ref, label: suggestion.label, prompt: suggestion.prompt, card: null, suggestion };
  }
  return null;
}
