# AGENTS.md

A server-only bb plugin that gives Voice Mode (`steveafrost/bb-plugin-voice-mode`, MIT) an OpenAI
Realtime connection on the ChatGPT subscription, from the token `codex login` keeps in
`~/.codex/auth.json`. It is new here, not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `codex-realtime`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | The settings, the load-time login check, and the one discoverable RPC with its caller guard. |
| `server/codex-login.ts` | Reading and checking `auth.json`: missing, malformed, expired. Read-only. |
| `server/connection.ts` | The RPC's input and output schemas and the `wss://` URL with the bearer header. |
| `testing/fake-login.ts` | Temporary Codex homes and made-up JWT-shaped tokens for the tests. |
| `scripts/live-check.ts` | A manual check against OpenAI (`npm run live-check`, Node 23.6+). Not in `npm test`. |

## The contract with Voice Mode

Voice Mode 0.1.9 (`server.ts`, `pluginConnection`) calls `bb.sdk.plugins.experimental_discoverRpc({
method: "realtimeConnection" })`, takes the first plugin other than itself, and calls it with `{}`, then
with `{ refresh: true }` once if the WebSocket handshake fails before the session starts. It parses the
answer as `{ protocol: "openai-realtime", url: "wss://…", headers?, model? }` and opens the socket from
the bb server with those headers. Its own `model` setting is then ignored. Keep the output schema in
`server/connection.ts` a subset of Voice Mode's: a field it does not know is fine, a field it requires
that we drop is not.

The first plugin offering `realtimeConnection` wins, so a second connection plugin installed beside this
one may take over.

## Invariants

- **Never refresh the token, never write `auth.json`.** Codex's refresh tokens rotate; a second program
  refreshing the same file can leave Codex with a used refresh token and sign it out. Expired means "run
  `codex` / `codex login`", nothing more. Do not add a refresh, however convenient.
- **Never pose as the Codex app.** No Codex OAuth client id, no Codex user agent or originator headers:
  the token goes out as a plain `authorization: Bearer`, as an API key would.
- **The token reaches only allowed plugins.** The handler refuses any caller that is not
  `{ kind: "plugin" }` with an id in the `allowedPlugins` setting. bb sets `experimental_caller` to
  `{ kind: "plugin", pluginId }` only for a loaded plugin's own `callRpc`, verified with a per-load
  token, and to `{ kind: "client" }` for the app, the CLI and agents — so `bb plugin rpc call
  codex-realtime realtimeConnection` cannot print the token into a transcript. A bb that passes no
  context at all is refused too.
- **The token is never logged, thrown or put in a fixture.** Error messages name the file and the
  problem only. Tests build fake tokens in `testing/fake-login.ts` and check that no part of one reaches
  the log or an error. A token that is not three base64url parts is refused as malformed before it
  is returned: Node's `Headers` and `WebSocket` quote the whole header value when they reject one (a line
  break inside it, say), and Voice Mode logs and shows that error.
- **Read on every call, no cache.** A token Codex refreshed since the last session is picked up at once,
  which is all `refresh: true` asks for.

## Which machine

The file is read with `homedir()` on the machine running the bb server, not through a `bb.host` entry:
Voice Mode opens the Realtime socket from the bb server too, and the Codex login has to be on that
machine. If bb's server ever runs where there is no Codex login, this needs a host entry.

## What the subscription accepts

Observed with `npm run live-check` on 2026-11-06 (bb 0.49, a ChatGPT subscription):

- `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1` accepts the Codex access token as bearer.
- `gpt-4o-mini-transcribe` input transcription works in that session, as does audio output with the
  `marin` voice and `semantic_vad`.
- Not tried: other Realtime models, `gpt-realtime-whisper`. `gpt-live-1` is known to refuse the token
  (Handsfree, `swairshah/bb-handsfree`, reports a 403), and Voice Mode does not use it.

Handsfree has no licence; nothing here is copied from it.
