# Changelog

Notable changes to `model-pricing`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

The first release: Model Pricing for bb, ported from the Paseo plugin of the same name (0.3.0).

### Added

- **A Model pricing page** in the sidebar: one table of what every model costs across Anthropic,
  OpenAI, Fireworks AI, Ollama Cloud and OpenRouter — the price per million tokens in and out, the
  context window, the longest reply, and whether each model can reason, call tools, return structured
  output and take a temperature.
- **A relative-cost column** that ranks every model against the cheapest one on screen, using an
  input/output blend you choose in the settings.
- **Sorting, search, and coloured provider dots** that hide a provider's models for a moment without
  fetching anything.
- **Every row opens that model's own page** on the provider's site.
- **Settings** to choose which providers are fetched and shown, the blend, and whether to list only
  models that can call tools.
- **A narrow-window layout** with one card per model.
- **Two palette commands**: open the price table, and open its settings.
- Prices are kept for twelve hours and refreshed on request; when a source cannot be reached, the last
  prices it gave stay on screen with a note saying how old they are.
