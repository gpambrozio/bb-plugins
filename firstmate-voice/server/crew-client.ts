/**
 * `CrewPort` over firstmate-crew's `voice.v1`, called as this plugin (`bb.sdk.plugins.callRpc`), which is what
 * its caller gate checks. Outputs are validated against this plugin's copy of the contract.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";

import { VoiceBriefSchema, VoiceCardSchema, VoiceReplySchema, VoiceSentSchema, voiceContract } from "../shared/crew-voice";
import type { CrewPort } from "./ports";

export const CREW_PLUGIN = "firstmate-crew";

const MateSchema = voiceContract["voice.v1.mate"].output;

export function crewClient(bb: BbPluginApi): CrewPort {
  function call<T>(method: keyof typeof voiceContract, input: Record<string, string>, outputSchema: z.ZodType<T>): Promise<T> {
    return bb.sdk.plugins.callRpc({ pluginId: CREW_PLUGIN, method, input, outputSchema });
  }

  return {
    brief: () => call("voice.v1.brief", {}, VoiceBriefSchema),
    card: (ref) => call("voice.v1.card", { ref }, VoiceCardSchema),
    reply: () => call("voice.v1.reply", {}, VoiceReplySchema),
    ask: (words, account) => call("voice.v1.ask", { words, account }, VoiceSentSchema),
    answer: (ref, words, account) => call("voice.v1.answer", { ref, words, account }, VoiceSentSchema),
    mateThreadId: async () => (await call("voice.v1.mate", {}, MateSchema)).threadId,
  };
}
