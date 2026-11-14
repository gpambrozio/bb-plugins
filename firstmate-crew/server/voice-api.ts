/**
 * The `voice.v1` handlers (`shared/voice.ts`): the brief, a card, the first mate's last reply, and the three
 * sends — ask, answer and press.
 *
 * - **The caller gate.** Every handler refuses unless bb names the caller as a plugin listed in the
 *   `voicePlugins` setting, the way codex-realtime gates its token. The bb app and `bb plugin rpc call` are
 *   refused too: the verbs here speak for the captain.
 * - **Words, verbatim and marked.** An ask or an answer is the captain's transcribed words under
 *   `VOICE_SPOKEN_PREFIX`, on one line, with any prefix inside them defused, plus an agent-only note. The
 *   voice plugin copies the words from its transcript; the model never writes them.
 * - **A press sends exactly the button's prompt**, under `VOICE_PRESSED_PREFIX`, and only for a card or
 *   suggestion unchanged since the voice read it (its etag), and never for a tap-only button. A pressed
 *   suggestion leaves `data/suggestions.md` as it does when the board presses it.
 * - **One send at a time,** through `askMate`'s path: compact-first when due, mode `auto`, never an interrupt.
 */
import { experimental_PluginRpcRefusal as PluginRpcRefusal, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";

import { answerText, cardSubject } from "../app/format";
import type { Fleet } from "../shared/types";
import { VOICE_PRESSED_PREFIX, VOICE_SPOKEN_PREFIX, voiceContract, type VoiceBrief, type VoiceReply, type VoiceSent } from "../shared/voice";
import { RELAY_PREFIX } from "./cli";
import { sendCompactingIfDue } from "./compact-first";
import { removeSuggestion } from "./home";
import { compactFirstDeps, requireMate, resolveMate, type MateDeps } from "./mate";
import { serialized } from "./serialize";
import { voicePluginIds } from "./settings";
import { TEMPLATES, message } from "./templates";
import {
  REPLY_CUT,
  buildVoiceBrief,
  findCard,
  ownerRef,
  resolveButton,
  threadTitles,
  untrusted,
  voiceCard,
  type MateVoiceState,
  type VoiceRefs,
} from "./voice-brief";

export interface VoiceDeps extends MateDeps {
  /** The board as `fleet.load` builds it. */
  fleet: () => Promise<Fleet>;
  refs: VoiceRefs;
  /** The home the crew works in (`activeHome`). */
  home: () => Promise<string>;
  /** Every open board reads the fleet again. */
  published: () => void;
  now: () => number;
}

/** Who bb says is calling: a plugin by id, or a client (the app, `bb plugin rpc call`). */
type Caller = { kind: "plugin"; pluginId: string } | { kind: string };

/** Throws unless the caller is a plugin the `voicePlugins` setting names. */
export async function requireVoiceCaller(deps: MateDeps, caller: Caller | undefined): Promise<string> {
  if (caller?.kind !== "plugin" || !("pluginId" in caller)) {
    throw new PluginRpcRefusal({ code: "forbidden", message: "voice.v1 answers only a voice plugin, never the app or a terminal." });
  }
  const allowed = voicePluginIds((await deps.settings()).voicePlugins);
  if (!allowed.has(caller.pluginId)) {
    deps.log.warn(`Refused voice.v1 to plugin ${caller.pluginId}: not in the voicePlugins setting.`);
    throw new PluginRpcRefusal({
      code: "forbidden",
      message: `Plugin ${caller.pluginId} may not talk to the first mate. Add it to FirstMate's "Plugins that may talk to the first mate by voice" setting.`,
    });
  }
  return caller.pluginId;
}

/** Every line that marks where a message came from; the captain's words must not carry one. */
const MARKS = [VOICE_SPOKEN_PREFIX, VOICE_PRESSED_PREFIX, RELAY_PREFIX].map((mark) => mark.replace(/:$/u, ""));

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The captain's words on one line, with any of the marks quoted and stripped of their colon, so nothing in
 * them can read as the start of another message. The charter counts a mark only at a message's very start.
 */
export function defuse(words: string): string {
  let text = words.replace(/\s+/gu, " ").trim();
  for (const mark of MARKS) {
    text = text.replace(new RegExp(`${escapeRegExp(mark)}:?`, "giu"), (found) => `"${found.replace(/:$/u, "")}"`);
  }
  return text;
}

/** What the voice reads of the first mate: its status, whether it waits on someone, its last reply and when. */
export class MateReplyCache {
  private cached: { seq: number; text: string | null } | null = null;

  async state(deps: MateDeps): Promise<MateVoiceState | null> {
    const mate = await resolveMate(deps);
    if (mate === null) return null;
    const [end, pending] = await Promise.all([deps.threads.lastTurnEnd(mate.id), deps.threads.pendingInteractions(mate.id)]);
    let reply: string | null;
    if (end !== null && this.cached?.seq === end.seq) {
      reply = this.cached.text;
    } else {
      const last = await deps.threads.lastText(mate.id);
      reply = last !== null && last.trim() !== "" ? last : await deps.threads.lastAgentMessage(mate.id);
      if (end !== null) this.cached = { seq: end.seq, text: reply };
    }
    return { status: mate.status, waiting: pending > 0, reply, repliedAt: end?.at ?? null };
  }
}

function notFound(ref: string): PluginRpcRefusal {
  return new PluginRpcRefusal({ code: "not_found", message: `There is no ${ref} on the board now. Read the brief again.` });
}

/** The handlers, each behind the caller gate. */
export function voiceHandlers(deps: VoiceDeps, replies: MateReplyCache = new MateReplyCache()): ExperimentalPluginRpcHandlersWithContext<typeof voiceContract> {
  const brief = async (): Promise<VoiceBrief> => {
    const [fleet, mate] = await Promise.all([deps.fleet(), replies.state(deps)]);
    return buildVoiceBrief(fleet, mate, deps.refs, deps.now());
  };

  /** Sends to the first mate one at a time, the way the captain's own words go (`askMate`), and refreshes the boards. */
  const send = (shown: string, note: string): Promise<VoiceSent> =>
    serialized("voice-send", async () => {
      const mate = await requireMate(deps);
      const delivery = await sendCompactingIfDue(compactFirstDeps(deps), mate.id, "auto", (mode) =>
        deps.threads.sendWithNote(mate.id, shown, note, mode),
      );
      deps.published();
      return { delivery };
    });

  return {
    "voice.v1.brief": async (_input, ctx) => {
      await requireVoiceCaller(deps, ctx?.experimental_caller);
      return brief();
    },
    "voice.v1.card": async ({ ref }, ctx) => {
      await requireVoiceCaller(deps, ctx?.experimental_caller);
      const card = voiceCard(await deps.fleet(), deps.refs, ref);
      if (card === null) throw notFound(ref);
      return card;
    },
    "voice.v1.reply": async (_input, ctx): Promise<VoiceReply> => {
      await requireVoiceCaller(deps, ctx?.experimental_caller);
      const [fleet, mate] = await Promise.all([deps.fleet(), replies.state(deps)]);
      return {
        reply: mate?.reply == null ? null : untrusted(mate.reply, REPLY_CUT.head, REPLY_CUT.tail, threadTitles(fleet)),
        repliedAt: mate?.repliedAt == null ? null : new Date(mate.repliedAt).toISOString(),
        status: mate === null ? null : mate.status,
      };
    },
    "voice.v1.ask": async ({ words, context }, ctx) => {
      await requireVoiceCaller(deps, ctx?.experimental_caller);
      const note = await message(TEMPLATES.voiceAskNote, {
        context: context === undefined || context.trim() === "" ? "none given." : defuse(context),
      });
      return send(`${VOICE_SPOKEN_PREFIX}\n\n${defuse(words)}`, note);
    },
    "voice.v1.answer": async ({ ref, words }, ctx) => {
      await requireVoiceCaller(deps, ctx?.experimental_caller);
      if (!/^c\d+$/u.test(ref)) throw notFound(ref);
      const card = findCard(await deps.fleet(), deps.refs, ref);
      if (card === null) throw notFound(ref);
      return send(`${VOICE_SPOKEN_PREFIX}\n\n${answerText(cardSubject(card), defuse(words))}`, await message(TEMPLATES.voiceAnswerNote));
    },
    "voice.v1.press": async ({ ref, etag }, ctx) => {
      await requireVoiceCaller(deps, ctx?.experimental_caller);
      const owner = ownerRef(ref);
      if (owner === null) throw notFound(ref);
      const fleet = await deps.fleet();
      const card = voiceCard(fleet, deps.refs, owner);
      const button = resolveButton(fleet, deps.refs, ref);
      const pressable = card?.pressable.find((item) => item.ref === ref);
      if (card === null || button === null || pressable === undefined) throw notFound(ref);
      if (card.etag !== etag) {
        throw new PluginRpcRefusal({ code: "conflict", message: `${card.title} changed since it was read back. Read it again before pressing.` });
      }
      if (pressable.tapOnly !== null) {
        throw new PluginRpcRefusal({
          code: "forbidden",
          message: `"${pressable.label}" is ${pressable.tapOnly}: the captain presses it on the board, never by voice.`,
        });
      }
      const sent = await send(`${VOICE_PRESSED_PREFIX}\n\n${button.prompt}`, await message(TEMPLATES.voicePressNote, { readBack: pressable.readBack }));
      // As the board does once a suggestion is sent: by label and prompt, so a rewritten file loses it or nothing.
      if (button.suggestion !== null) {
        try {
          await removeSuggestion(await deps.home(), button.suggestion);
          deps.published();
        } catch (error) {
          deps.log.warn(`A suggestion pressed by voice was sent but could not be taken off the board: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return sent;
    },
    "voice.v1.mate": async (_input, ctx) => {
      await requireVoiceCaller(deps, ctx?.experimental_caller);
      return { threadId: (await resolveMate(deps))?.id ?? null };
    },
  };
}
