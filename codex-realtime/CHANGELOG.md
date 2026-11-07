# Changelog

Notable changes to `codex-realtime`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

The first release.

### Added

- **Voice Mode on your ChatGPT subscription.** With this plugin installed, Voice Mode's voice chats use
  the ChatGPT sign-in Codex keeps on this Mac instead of an OpenAI API key. Voice Mode stays as it is,
  on its default Connection: auto setting.
- **Your Codex sign-in is only read.** The plugin never renews it and never changes Codex's files.
  When the sign-in is missing or has expired, the message says to run `codex login`.
- **A Realtime model setting**, `gpt-realtime-2.1` to begin with.
- **A list of the plugins allowed to use the sign-in**, only Voice Mode to begin with. The bb app and
  agents never receive it.
