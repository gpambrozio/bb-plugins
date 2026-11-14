# FirstMate Voice (phase 0 spike)

Not released. This folder is the phase 0 spike for real-time voice with FirstMate: talking to OpenAI
Realtime from a bb page, on the ChatGPT subscription that codex-realtime already uses. The results and the
decision record are in [AGENTS.md](AGENTS.md).

Run it only in a dev bb (root `AGENTS.md`, "A dev bb for live checks"), never in your own bb:

1. Install `codex-realtime` and this plugin there, and add `firstmate-voice` to codex-realtime's
   **Plugins that may use the sign-in** setting.
2. Open **Voice spike** in the sidebar, tap **Run all checks**, and speak when the page says so.

`npm run live-check-call` checks which Realtime paths the subscription token opens.
`npm run desktop-check -- --url <dev bb>` drives the page with a spoken clip as the microphone. Both spend
a little of your ChatGPT plan's voice time.
