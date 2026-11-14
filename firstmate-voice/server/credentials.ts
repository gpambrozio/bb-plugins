// Where the plugin gets its bearer: codex-realtime's `realtimeConnection`, which reads the ChatGPT
// subscription token from the Codex login (never refreshed, never written). The token stays behind
// codex-realtime's caller gate, so this plugin must be on its "Plugins that may use the sign-in" list. bb's
// build refuses a server import from outside the plugin folder, so the credential comes over RPC.
//
// The token is held in server memory for one call's life (the SDP exchange, the sideband, the hangup) and
// never logged or sent to the app.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const ConnectionOutput = z.object({
  protocol: z.literal("openai-realtime"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  model: z.string(),
});

export const CREDENTIAL_PLUGIN = "codex-realtime";

export async function subscriptionToken(bb: BbPluginApi, signal?: AbortSignal): Promise<string> {
  let connection: z.infer<typeof ConnectionOutput>;
  try {
    connection = await bb.sdk.plugins.callRpc({
      pluginId: CREDENTIAL_PLUGIN,
      method: "realtimeConnection",
      input: {},
      outputSchema: ConnectionOutput,
      signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `FirstMate voice needs the ChatGPT sign-in from the codex-realtime plugin, with firstmate-voice on its "Plugins that may use the sign-in" list. It answered: ${reason}`,
    );
  }
  const header = connection.headers.authorization ?? connection.headers.Authorization ?? "";
  const token = header.replace(/^Bearer\s+/u, "");
  if (!token) throw new Error("codex-realtime answered without a bearer header.");
  return token;
}
