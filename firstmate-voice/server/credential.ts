// Where the plugin gets its bearer: codex-realtime's `realtimeConnection`,
// the phase 1 path. The token stays behind codex-realtime's caller gate, so
// this plugin must be on its "Plugins that may use the sign-in" list. bb's
// build refuses a server import from outside the plugin folder, so there is
// no in-process fallback here; scripts/live-check-call.ts does the in-process
// read instead.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const ConnectionOutput = z.object({
  protocol: z.literal("openai-realtime"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  model: z.string(),
});

export type Credential = { token: string; source: "codex-realtime" };

export async function subscriptionToken(bb: BbPluginApi, signal?: AbortSignal): Promise<Credential> {
  const connection = await bb.sdk.plugins.callRpc({
    pluginId: "codex-realtime",
    method: "realtimeConnection",
    input: {},
    outputSchema: ConnectionOutput,
    signal,
  });
  const header = connection.headers.authorization ?? connection.headers.Authorization ?? "";
  const token = header.replace(/^Bearer\s+/u, "");
  if (!token) throw new Error("codex-realtime answered without a bearer header.");
  return { token, source: "codex-realtime" };
}
