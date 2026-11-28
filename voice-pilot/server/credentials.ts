/**
 * Where a call's bearer comes from, by the **Connection** setting:
 *
 * - `api-key`: the **OpenAI API key** setting, a bb secret (a 0600 file on the server, never sent to the app).
 * - `chatgpt`: the ChatGPT subscription, from this repository's codex-realtime plugin (`realtimeConnection`),
 *   which must list `voice-pilot` in its "Plugins that may use the sign-in" setting. bb's build refuses a
 *   server import from outside the plugin folder, so the credential comes over RPC.
 * - `auto`: the API key when one is set, else the ChatGPT subscription.
 *
 * The bearer is held in server memory for one call's life (the SDP exchange, the sideband, the hangup) and is
 * never logged, put in the debug log or sent to the app.
 */
import { z } from "zod";

export const CREDENTIAL_PLUGIN = "codex-realtime";
export const CONNECTIONS = ["auto", "api-key", "chatgpt"] as const;
export type Connection = (typeof CONNECTIONS)[number];

const ConnectionOutput = z.object({
  protocol: z.literal("openai-realtime"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  model: z.string(),
});

/** What the credential lookup needs from bb. */
export interface CredentialDeps {
  settings(): Promise<{ connection: string; openaiApiKey: string | undefined }>;
  callCodexRealtime(signal?: AbortSignal): Promise<unknown>;
}

/** The ChatGPT subscription's bearer, through codex-realtime. */
export async function subscriptionToken(deps: Pick<CredentialDeps, "callCodexRealtime">, signal?: AbortSignal): Promise<string> {
  let connection: z.infer<typeof ConnectionOutput>;
  try {
    connection = ConnectionOutput.parse(await deps.callCodexRealtime(signal));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Voice Pilot needs the ChatGPT sign-in from the codex-realtime plugin, with voice-pilot on its "Plugins that may use the sign-in" list, or an OpenAI API key in Voice Pilot's settings. codex-realtime answered: ${reason}`,
    );
  }
  const header = connection.headers.authorization ?? connection.headers.Authorization ?? "";
  const token = header.replace(/^Bearer\s+/u, "");
  if (!token) throw new Error("codex-realtime answered without a bearer header.");
  return token;
}

/** Which connection a call uses, given the setting and whether an API key is set. */
export function chooseConnection(setting: string, hasKey: boolean): "api-key" | "chatgpt" {
  if (setting === "api-key") return "api-key";
  if (setting === "chatgpt") return "chatgpt";
  return hasKey ? "api-key" : "chatgpt";
}

/** The bearer for the next call, and which connection gave it (for the debug log; never the bearer). */
export async function callToken(deps: CredentialDeps, signal?: AbortSignal): Promise<{ token: string; connection: "api-key" | "chatgpt" }> {
  const { connection, openaiApiKey } = await deps.settings();
  const key = (openaiApiKey ?? "").trim();
  const chosen = chooseConnection(connection, key !== "");
  if (chosen === "api-key") {
    if (key === "") throw new Error("Voice Pilot's Connection is set to the API key, but no OpenAI API key is set. Add one in Voice Pilot's settings.");
    return { token: key, connection: chosen };
  }
  return { token: await subscriptionToken(deps, signal), connection: chosen };
}
