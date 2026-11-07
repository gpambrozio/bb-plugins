// The answer a `realtimeConnection` caller (Voice Mode) expects: where to open
// an OpenAI Realtime WebSocket, and with which headers.
import { z } from "zod";

export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
export const DEFAULT_MODEL = "gpt-realtime-2.1";

export const RealtimeConnectionInput = z
  .object({
    /** The caller's last connection was refused; read the login again. */
    refresh: z.boolean().optional(),
  })
  .nullish();

/** Voice Mode's own schema for this answer (its server.ts, `RealtimeConnection`). */
export const RealtimeConnectionOutput = z.object({
  protocol: z.literal("openai-realtime"),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("wss://"), "realtimeConnection url must use wss://"),
  headers: z.record(z.string(), z.string()),
  model: z.string(),
});
export type RealtimeConnectionOutput = z.infer<typeof RealtimeConnectionOutput>;

export function realtimeConnection(accessToken: string, model: string): RealtimeConnectionOutput {
  const url = new URL(OPENAI_REALTIME_URL);
  url.searchParams.set("model", model);
  return {
    protocol: "openai-realtime",
    url: url.toString(),
    headers: { authorization: `Bearer ${accessToken}` },
    model,
  };
}

/** The model setting as typed, or the default when it is blank. */
export function modelOrDefault(value: string | undefined): string {
  const model = value?.trim();
  return model ? model : DEFAULT_MODEL;
}
