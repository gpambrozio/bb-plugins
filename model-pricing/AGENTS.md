# AGENTS.md

A bb plugin that adds a **Model pricing** sidebar page: one sortable table of what every model on the
enabled providers costs, ranked against the cheapest one on screen. It is the port of the Paseo plugin
`model-pricing` (0.3.0).

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `model-pricing`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wiring: the settings form, the one RPC, the cache drained on dispose. |
| `shared/providers.ts` | The five providers, which upstream each is read from, and their colour pairs. Plain values. |
| `shared/pricing.ts` | `PriceRow`, the per-source status, and the `load` input/output. Zod only, no SDK. |
| `shared/contract.ts` | The RPC contract. Imports the SDK root, so the app imports it as a type only. |
| `shared/settings.ts` | The settings bb renders, and `displayFrom`, which reads them back in the app. |
| `shared/format.ts` | Every number the table prints, and the relative-cost ranking. Pure. |
| `shared/sort.ts` | The column comparator. |
| `shared/model-links.ts` | Model id → the vendor's page for it, and the Fireworks owner exceptions. Pure. |
| `server/normalize.ts` | Each upstream's JSON → `PriceRow[]`. Pure, defensive, skips rather than throws. |
| `server/sources.ts` | The two HTTP fetches, `fetch` injected. ETag revalidation for models.dev. |
| `server/cache.ts` | One `bb.storage.kv` value per upstream, TTL and ETag. |
| `server/pricing.ts` | The handler: which sources to fetch, cache or network, and what a failure returns. |
| `app/pricing-panel.tsx` | The page: header, legend, search, banners, the module-scope session, the fetch effect. |
| `app/visible.ts` | The filter → rank → sort pipeline and the lines around the table. Pure. |
| `app/table.tsx` | The wide grid, the narrow card, and the row links. |
| `app/open-settings.ts` | Opens the plugin's settings page; the same internal-route push as `herald`. |

`npm test` runs everything; `app/pricing-panel.test.tsx` renders the panel in jsdom through the SDK's
`renderSlot`.

## Nobody sells a pricing API

This is the fact the whole plugin is shaped around, and it is worth not rediscovering:

- **Anthropic, OpenAI and Fireworks publish no prices programmatically.** Each has a `GET
  /v1/models`, each needs an API key, and none of the three returns a price. Their prices exist only
  on HTML pricing pages.
- **models.dev is therefore the source for four of the five providers.** Its model shape happens to
  be exactly this table's columns — `limit.context`, `limit.output`, `cost.input`, `cost.output`,
  `reasoning`, `tool_call`, `structured_output`, `temperature` — which is why the table looks the way
  it does rather than the other way round.
- **`https://models.dev/api.json` is its only JSON endpoint.** One 4.7 MB document or nothing.
- **OpenRouter is read first-hand** because models.dev mirrors it some way behind, and OpenRouter's own
  endpoint is unauthenticated.

The catalog keys are not the provider ids: `fireworks-ai` and `ollama-cloud`. `shared/providers.ts`
holds the mapping and `server/normalize.ts` walks only the four it needs.

## The 4.7 MB never reaches the cache or the wire

`server/cache.ts` stores normalized `PriceRow[]`, not the document they were parsed out of. **Do not
"simplify" this by caching the raw response.** With every provider on (2026-10-01): 567 rows, the
OpenRouter value 129 KB and the models.dev value 29 KB as JSON, and a `load` answer of 157 KB.
`bb.storage.kv` refuses a value over 256 KB, so OpenRouter has about twice its current size left. A
refused write is logged (`could not store the openrouter cache`) and the rows stay in memory; if that
starts happening, split the value or move to `bb.storage.database()`.

models.dev honours `If-None-Match` and answers **304**, so `fetchModelsDev` sends the stored ETag and a
refresh that changes nothing costs one round trip and no parse. On a 304 the handler keeps the rows and
*restamps* `fetchedAt`; without the restamp every load past the TTL would revalidate again forever.
`fetchModelsDev` also falls back to the ETag it sent when a 304 does not repeat one — losing it turns
every later refresh back into a full download. An ETag is never stored beside an empty row set, so a
degraded-but-valid answer cannot pin the table empty behind 304s.

OpenRouter has no ETag and does not need one.

The cache outlives a reload. The new instance loads before the old one is disposed, so a write the old
one still had queued can land after the new one has read; the cost is one refetch, and `onDispose`
drains the queue so the write is not lost.

## A source that fails must not blank the table

`server/pricing.ts` settles each source on its own and returns its error **as a string beside the
rows**, never by throwing:

- one upstream down, the other fine → the other's rows are on screen under a banner;
- a refresh that fails with something cached → the stale rows come back with the *cache's*
  `fetchedAt`, so the panel can say how old they are;
- a failure with nothing cached → an empty table and the reason, logged once.

The handler keeps one fetch per source in flight at a time, because four of the five providers share
the models.dev document. **A `refresh: true` deliberately bypasses that dedupe** — the user pressed
Refresh because they doubt what is on screen.

## Absent is not false

Every capability on a `PriceRow` is `boolean | null`, and `null` means *the upstream did not say*.
Both render as an em dash. The tool-call filter drops `toolCall === false` and **keeps `null`**. The one
thing a row may not lack is a price — a row with no price cannot be ranked, so `normalize.ts` drops it.
A malformed *model* is skipped; only a malformed *document* throws.

## Nobody publishes a link either

Neither upstream carries a URL for a model, so every link in `shared/model-links.ts` is derived from the
model id, each rule checked against the live sites (2026-09-21):

| Provider | Rule |
| --- | --- |
| Anthropic | `platform.claude.com/docs/en/models/<slug>/overview`, slug = id minus `claude-` minus a `-YYYYMMDD` pin. |
| OpenAI | `developers.openai.com/api/docs/models/<slug>`, slug = id minus a `-YYYY-MM-DD` snapshot date. |
| Ollama Cloud | `ollama.com/library/<name>`, name = id minus `:tag`. |
| OpenRouter | `openrouter.ai/<id>`. The id *is* the path — never encode it. |
| Fireworks AI | `fireworks.ai/models/<owner>/<slug>`; the owner is not in the id, so `FIREWORKS_OWNERS` lists the dozen that are not `fireworks/`. Routers get the models list filtered to the name. |

A derived link is best effort, and `FIREWORKS_OWNERS` **goes stale silently**; re-take it by scraping
the hrefs off `fireworks.ai/models`. `null` means *no rule*, and the row is then a plain `div` rather
than a link to somewhere approximate. The whole row is the link (bb's `UrlLink`, which follows the
user's in-app/external browser choice).

## The relative column is a setting, not a formula

`relativeCosts` blends input and output into one number and divides by the cheapest, so the cheapest
reads `1.0×`.

- **The blend weight is a user setting** (`INPUT_WEIGHTS`). There is no neutral answer, and models
  genuinely reorder between an input-heavy agent and an output-heavy chat.
- **The baseline is the cheapest *visible* row**, computed in the app over the filtered set. Switching
  a provider off, hiding it, or searching moves it, on purpose.
- **Free models keep a blend of 0**, are excluded from the baseline, and print **Free** — even when no
  paid row is visible.

The map is keyed `providerId/modelId`: a model id is unique only within a provider.

## Settings are the app's, and the switch is the fetch

Every setting is read by the app and none by the server. bb renders the form from `SETTINGS`
(`shared/settings.ts`): one boolean per provider keyed by its id, the blend as a `select`, and the
tool-call filter. The app reads them through `useSettings()` and `displayFrom`, which treats them as
untrusted (missing while loading, an option from an older build).

"Which providers to fetch" and "which providers to show" are the same switch: the panel passes the
enabled ids into `load`, so a provider switched off is genuinely not fetched. **Do not add a
server-side copy of the list.** Four of the five share one fetch, so switching Anthropic off saves
nothing until OpenAI, Fireworks and Ollama Cloud are off too; `sourcesFor` decides that.

**The legend dots and the settings switches are deliberately different controls.** A switch decides
what is *fetched*; a dot decides what is *drawn*, instantly and with no network. Wiring a dot to the
settings would remove the very dot needed to undo it. A provider switched off in settings is pruned
from the hidden set, so switching it back on does not return it still hidden.

## The panel keeps a session at module scope

The panel is a route (`/plugins/model-pricing/pricing`), so opening a thread unmounts it. The last
answer, the sort, the search and the hidden set live in `session` in `app/pricing-panel.tsx`, so a
return visit paints at once, keeps the user's place, and refetches only past `STALE_AFTER_MS`. None of
it is persisted; it dies with the window.

`latestRequest` drops an answer that lands after a newer request, and `requestedKey` keeps a failed
fetch (or its own `busy` re-render) from starting another. Both effects key on primitives pulled out
of the settings, never on the values object.

## Ten columns do not fit a phone

The panel measures its own width (`ResizeObserver`, `COMPACT_BELOW_PX`) — not the window's, since the
sidebar and a split take their share — and below it draws a card per model instead of the grid. The
grid's headings are `sticky` in the scrolling area, so a price three hundred rows down still reads as
a price. The card layout has no headings, so it keeps whatever sort the wide layout last chose.

## Provider colours are a palette, and that is on purpose

**`shared/providers.ts` is the one place that does not take a colour from bb's semantic classes**, and
it is a considered exception. bb's semantic colours mean something (`text-destructive`,
`text-success`, `text-warning-text`) and offer no five neutral hues; painting Anthropic "destructive" is
a sentence about Anthropic. In Paseo a theme token was tried first and shipped two providers in the same
green; `shared/providers.test.ts` asserts all five are distinct, in both variants.

Each provider carries a `{ dark, light }` pair of the same hue at two lightnesses, applied as inline
styles. `pickAccent` chooses by **`experimental_useCodeTheme().mode`**, which changes the moment the
user switches light/dark. Do not reach for Tailwind's `dark:` variant instead: bb 0.44's plugin build
compiles it to `@media (prefers-color-scheme: dark)`, which follows the operating system, not the
appearance chosen in bb.

Adding a sixth provider means adding a sixth hue pair and checking it against the other five in both
modes.

## No pricing in bb's model chooser

The owner asked whether this plugin could show prices in bb's own model chooser (the provider/model
picker in the composer). **bb 0.44 / SDK 0.5.29 gives a plugin no supported way to do that**, checked
2026-10-01 against the SDK declarations:

- `PluginAppSlots` (`bundled-types/bb-plugin-sdk-app.d.ts:18630`) has no model-picker slot, and
  `ComposerCustomization` (`:18889`) offers only `actions`, `banners`, `plusMenu` and `richText` — none
  of them decorates a model row.
- `ComposerView` (`:18922`), the reactive composer state a banner or action gets, carries the scope,
  layout, draft and run state, and **no provider or model**.
- The only server hook is `message.dispatch` (`bb-plugin-sdk.d.ts:20994`); there is no model-catalog
  transform. A provider's `models` (`:21719`) belong to a provider the plugin registers itself, not to
  Claude Code or Codex.
- `experimental_ProviderModelPicker` (`bb-plugin-sdk-app.d.ts:19262`) is bb's picker for a plugin to
  embed in its *own* surface; its props take no row renderer or annotation.
- `bb guide plugins` and the bb-plugin-authoring skill describe nothing more.

The nearest thing is a composer banner showing the price of the model the composer has selected,
reading the selection with `useComposer().experimental_setSelection({})` (an experimental call that
resolves with the composer's settled selection). It is not the chooser, it has no change notification,
so it would need polling, and it was left as an open decision rather than built.

## Checking it

`npm test` covers everything that does not need a network: the formatters and the ranking, both
normalizers against trimmed copies of real upstream responses, the kv cache's TTL, ETag and corrupt
values, the handler's arbitration through a fake `fetch`, the settings parsing, the panel pipeline, and
a jsdom render of the panel.

To check the server half against reality, write a throwaway `server/*.tmp.test.ts` that builds a
`PricingCache` over an in-memory store, calls `createPricingHandler` with the real deps, and writes what
it got to a file; then delete it. Node's `fetch` does not use a sandbox's HTTP proxy, so run it where it
can reach `models.dev` and `openrouter.ai`. That is how the sizes above were taken. Against the
installed plugin, `bb plugin rpc call model-pricing load --input-file <file>` with
`{"providers":["anthropic","openai","fireworks","ollama","openrouter"]}` answers with the rows and a
status per source; the second call says `"cached": true`.

What it cannot cover, check by hand after `bb plugin reload model-pricing`:

1. Open **Model pricing** in the sidebar. Rows appear for every provider that is on; the line under
   the heading says how long ago they were fetched. `bb plugin logs model-pricing` shows any failure.
2. Press Refresh. It should be quick — models.dev answers 304 — and the line should say "just now".
3. Switch OpenRouter off in the settings: about 450 rows disappear and the relative baseline moves.
4. Change the blend to 25/75 and watch the order change.
5. Press column headings to sort, and the same one again to reverse it. Open a thread and come back:
   the sort and the search are still there, and the table paints without a wait.
6. Narrow the window (or open a split) until the cards appear; switch bb between light and dark.
7. Press a row on each provider and check the page that opens is that model's.
