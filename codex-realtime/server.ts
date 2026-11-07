// codex-realtime — the server entry.
//
// One discoverable RPC, `realtimeConnection`, in the shape Voice Mode looks
// for on its default `connection: auto` setting: where to open an OpenAI
// Realtime WebSocket, with the ChatGPT token `codex login` keeps in
// ~/.codex/auth.json as the bearer. The login is read on every call and never
// refreshed or written (server/codex-login.ts). The token goes only to another
// plugin on the allow list, never to the bb app or a `bb plugin rpc call`.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";

import { CodexLoginError, codexAuthPath, readCodexLogin } from "./server/codex-login";
import { DEFAULT_MODEL, RealtimeConnectionInput, RealtimeConnectionOutput, modelOrDefault, realtimeConnection } from "./server/connection";

export const rpcContract = defineRpcContract({
  realtimeConnection: { input: RealtimeConnectionInput, output: RealtimeConnectionOutput },
});

export const DEFAULT_ALLOWED_PLUGINS = "voice-mode";

/** Plugin ids from the setting: separated by commas or white space. */
export function parseAllowedPlugins(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(/[\s,]+/u).filter((id) => id !== ""));
}

export type PluginOptions = {
  /** Where the Codex login is read; `$CODEX_HOME/auth.json` or `~/.codex/auth.json` by default. */
  authPath?: string;
  now?: () => number;
};

export function createPlugin(options: PluginOptions = {}) {
  const authPath = options.authPath ?? codexAuthPath();
  const now = options.now ?? Date.now;

  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({
      model: {
        type: "string",
        label: "Realtime model",
        description: `The OpenAI Realtime model Voice Mode talks to. Blank means ${DEFAULT_MODEL}. Voice Mode's own model setting does not apply while this plugin is installed.`,
        default: DEFAULT_MODEL,
      },
      allowedPlugins: {
        type: "string",
        label: "Plugins that may use the sign-in",
        description:
          "Plugin ids, separated by commas, that may receive your ChatGPT token. The bb app and `bb plugin rpc call` never receive it.",
        default: DEFAULT_ALLOWED_PLUGINS,
      },
    });

    const missingLogin = (error: unknown) => {
      if (error instanceof CodexLoginError && error.problem === "missing") {
        bb.status.needsConfiguration(`${error.message} Then run \`bb plugin reload codex-realtime\`.`);
      }
    };

    // Say so at load when there is no login at all; an expired one is only
    // reported when a session asks, since Codex may refresh it before then.
    await readCodexLogin(authPath, now()).catch(missingLogin);

    bb.rpc.register(
      rpcContract,
      {
        // Every call reads the file again, so `refresh: true` (a caller whose
        // last connection was refused) needs nothing more.
        async realtimeConnection(_input, ctx) {
          const caller = ctx?.experimental_caller;
          if (caller?.kind !== "plugin") {
            throw new Error("codex-realtime hands its connection only to another plugin, such as Voice Mode.");
          }
          const current = await settings.get();
          if (!parseAllowedPlugins(current.allowedPlugins).has(caller.pluginId)) {
            bb.log.warn(`Refused a realtime connection to plugin ${caller.pluginId}: not in the allowed plugins setting.`);
            throw new Error(`Plugin ${caller.pluginId} is not allowed to use the ChatGPT sign-in. Add it to codex-realtime's allowed plugins setting.`);
          }
          let login;
          try {
            login = await readCodexLogin(authPath, now());
          } catch (error) {
            missingLogin(error);
            throw error;
          }
          const model = modelOrDefault(current.model);
          bb.log.info(`Realtime connection for ${caller.pluginId}: model ${model}, sign-in valid until ${new Date(login.expiresAt).toISOString()}.`);
          return realtimeConnection(login.accessToken, model);
        },
      },
      {
        experimental_discoverable: true,
        experimental_description: "An OpenAI Realtime connection on the ChatGPT subscription, from the Codex login.",
      },
    );
  };
}

export default createPlugin();
