# ChatGPT Realtime Connection (codex-realtime)

Lets [Voice Mode](https://github.com/steveafrost/bb-plugin-voice-mode) run on your ChatGPT
subscription instead of an OpenAI API key. It uses the sign-in that `codex login` already keeps on
the machine running the bb server.

Voice Mode, on its default **Connection: auto** setting, looks for an installed plugin that offers a
realtime connection and uses it before its own API key. This plugin is one: when Voice Mode starts a
voice chat, it gets the OpenAI Realtime address and your ChatGPT sign-in from here. Voice Mode itself
does not change.

## Read this first

- **This is an undocumented use of your subscription.** OpenAI documents the Realtime API for API
  keys. That it accepts the ChatGPT token Codex signs in with is something people found out, not
  something OpenAI promises. OpenAI already refuses that token for one of its voice models
  (`gpt-live-1`), so it can stop working for the others at any time, without notice.
- **OpenAI's terms have not been checked.** Nobody working on this plugin has read whether the ChatGPT
  or Codex terms allow another program to use the Codex sign-in this way. Decide that for yourself
  before you install it.
- **Your voice chats count against your ChatGPT plan**, the same plan Codex uses, under whatever limits
  OpenAI sets for it.

## What it does, and what it never does

- It reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) each time a voice chat starts, and hands
  the ChatGPT token in it to Voice Mode, which sends it to `api.openai.com` and nowhere else.
- It **never refreshes the token and never writes that file.** Codex renews its own sign-in, and two
  programs renewing the same sign-in can log Codex out. When the token has expired, run `codex` once
  to renew it, or `codex login` to sign in again.
- It does not pretend to be the Codex app. It sends the token as a plain bearer token, exactly as an
  API key is sent.
- It gives the token only to the plugins you allow (Voice Mode to begin with). The bb app, `bb plugin
  rpc call` and agents in threads never get it.
- It never logs or shows the token.

## What you need

- bb 0.46 or later, and Voice Mode 0.1.9 or later on its default **Connection: auto** (or **plugin**).
- The Codex CLI, signed in with **Sign in with ChatGPT** (`codex login`) on the machine running the bb
  server. An API-key login has no ChatGPT token.
- A ChatGPT plan that includes Codex.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin codex-realtime --tag-prefix codex-realtime/
```

Then start a voice chat as usual. Voice Mode's log says `plugin codex-realtime connection` when it
uses this plugin. If you installed this plugin before signing in to Codex, the Plugins page asks for
configuration: sign in, then run `bb plugin reload codex-realtime`.

On **Connection: auto**, a voice chat this plugin cannot serve falls back to Voice Mode's API key, and
without one Voice Mode asks for a key; this plugin's reason is in Voice Mode's log
(`bb plugin logs voice-mode`). Set Voice Mode's Connection to **plugin** to see the reason on screen
instead.

Uninstalling it puts Voice Mode back on its own API key.

## Settings

In bb's **Settings → Plugins → ChatGPT Realtime Connection**.

**Realtime model.** The model Voice Mode talks to, `gpt-realtime-2.1` by default. While this plugin
is installed, Voice Mode's own model setting does not apply; its voice setting still does.

**Plugins that may use the sign-in.** Plugin ids, separated by commas, that may receive your ChatGPT
token. `voice-mode` by default. Add another only if you trust it with your sign-in.

## When it stops working

- **"No Codex login found" or "has no ChatGPT sign-in".** Run `codex login` and choose Sign in with
  ChatGPT, on the machine running the bb server.
- **"The ChatGPT sign-in … expired".** Run `codex` once, or `codex login`.
- **The voice chat starts and then closes, with a sign-in that is not expired.** OpenAI may have
  stopped accepting the token for Realtime. `npm run live-check` in this folder opens one short
  session on your subscription and reports what OpenAI answered (see `AGENTS.md`).

## Tested

On 2026-11-06, with `gpt-realtime-2.1` on a ChatGPT subscription and Voice Mode 0.1.9's session
settings: the Realtime WebSocket accepted the token, `gpt-4o-mini-transcribe` (the transcription
model Voice Mode uses) transcribed the spoken clip, and a spoken reply came back.
