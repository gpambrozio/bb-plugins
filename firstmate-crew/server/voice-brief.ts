/**
 * The `voice.v1` brief and cards: what FirstMate voice knows of the fleet, built from `loadFleet` and the
 * first mate's last reply.
 *
 * - **Speakable.** Pull request URLs become "web #42", other URLs "a link on example.com", `@thread:`
 *   mentions the thread's title; thread ids, Markdown marks and line breaks go.
 * - **Untrusted and cut.** Anything a worker or the first mate wrote is marked untrusted and cut to its head
 *   and tail, so a closing status line survives a long message.
 * - **Refs, not prompts.** Cards are `c1`. A ref names the same card for the life of the plugin, whatever
 *   column it moves to. Buttons and suggestions go by their labels only: the voice never presses one, the
 *   captain taps it on the board, and the prompts stay here.
 */
import { createHash } from "node:crypto";

import { STATUS_WORDS } from "../app/format";
import type { Fleet, FleetCard, ThreadStatus } from "../shared/types";
import type { UntrustedText, VoiceAction, VoiceBrief, VoiceCard, VoiceCardBrief } from "../shared/voice";

// --- Speakable text --------------------------------------------------------------------------------

/** A GitHub pull request or issue, as it is said: "web #42". Null for any other address. */
export function spokenPr(url: string | null): string | null {
  if (url === null) return null;
  const match = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/([^/\s]+)\/(?:pull|issues)\/(\d+)/iu.exec(url);
  return match === null ? null : `${match[1]} #${match[2]}`;
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

// --- Refs and etags --------------------------------------------------------------------------------

/** A short hash of a JSON value: changes whenever the value does. */
export function etagOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/** What a card is, across columns: its task once it has one, else its board key. */
function cardIdentity(card: FleetCard): string {
  return card.taskId === null ? `key:${card.key}` : `task:${card.taskId}`;
}

/**
 * Refs handed out for the life of the plugin: a card keeps its `c` number whatever else changes. The maps grow by one entry per card ever seen, which a fleet's life keeps small.
 */
export class VoiceRefs {
  private readonly cards = new Map<string, string>();

  card(card: FleetCard): string {
    const identity = cardIdentity(card);
    let ref = this.cards.get(identity);
    if (ref === undefined) {
      ref = `c${this.cards.size + 1}`;
      this.cards.set(identity, ref);
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

function actionsOf(card: FleetCard): VoiceAction[] {
  return (card.backlog?.actions ?? []).map((action) => ({ label: action.label }));
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
    actions: actionsOf(card),
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
    suggestions: fleet.suggestions.map((suggestion) => ({ label: suggestion.label })),
    watches: {
      failing: fleet.watches
        .filter((watch) => watch.lastResult === "failed")
        .map((watch) => ({ name: watch.name, error: watch.lastError === null ? null : untrusted(watch.lastError, 160, 0).head })),
    },
  };
  return { ...body, at: new Date(now).toISOString(), etag: etagOf(body) };
}

// --- One card in detail ----------------------------------------------------------------------------

/** The fleet's card for a `c` ref, or null. */
export function findCard(fleet: Fleet, refs: VoiceRefs, ref: string): FleetCard | null {
  return fleet.cards.find((card) => refs.card(card) === ref) ?? null;
}

/** A card's detail for `voice.v1.card`; null for an unknown ref. */
export function voiceCard(fleet: Fleet, refs: VoiceRefs, ref: string): VoiceCard | null {
  if (!/^c\d+$/u.test(ref)) return null;
  const card = findCard(fleet, refs, ref);
  if (card === null) return null;
  const titles = threadTitles(fleet);
  return {
    ref,
    title: card.title,
    project: card.project,
    column: card.column,
    pr: spokenPr(card.url),
    hold: card.backlog?.hold == null ? null : speakable(card.backlog.hold, titles),
    lastWord: lastWord(card, CARD_WORD, titles),
    actions: actionsOf(card),
  };
}
