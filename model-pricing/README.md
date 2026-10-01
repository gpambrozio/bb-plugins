# Model Pricing (model-pricing)

One table of what every model on the providers you follow costs, so choosing which model to point an
agent at does not mean opening five vendor pricing pages and doing arithmetic. Ported from
[`paseo-plugins/model-pricing`](https://github.com/gpambrozio/paseo-plugins/tree/main/model-pricing).

The **Model pricing** page in the sidebar lists, for each model: the price per million tokens in and
out, the context window, how much it can write in one go, whether it can reason, call tools, return
structured output and take a temperature, and a relative-cost figure that measures it against the
cheapest model on screen. Sort by any of it, search by name, and switch providers on and off.

Prices come from two places, neither of which needs an API key. Anthropic, OpenAI and Fireworks AI
publish no pricing API at all — their own model endpoints want a key and return no prices — so those
three, together with Ollama Cloud, are read from [models.dev](https://models.dev), a community catalog
of model specifications. OpenRouter publishes its own, so it is read directly from OpenRouter. The bb
server does the fetching; nothing is sent anywhere.

## What you need

- bb 0.44 or later.
- Network access from the machine running the bb server to `models.dev` and `openrouter.ai`.

No accounts, keys or logins. The plugin only reads public price lists.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin model-pricing --tag-prefix model-pricing/
```

The page is **Model pricing** in the sidebar. The command palette has *Model pricing: open the price
table* and *Model pricing: open settings*.

## Settings

In bb's **Settings → Plugins → Model Pricing**, or the gear at the top of the page.

**Providers.** One switch each for Anthropic, OpenAI, Fireworks AI, Ollama Cloud and OpenRouter. A
provider switched off is not shown *and not fetched*. All five are on to begin with, which is a little
over five hundred models — OpenRouter alone is about 450 of them.

**Input / output blend.** The relative-cost column needs one number per model, and a model's input and
output prices are usually different, often by five times. This setting says how much of that blend is
input. The default, 80/20, suits an agent that reads a large repository and writes a small patch; a chat
that drafts prose is closer to 25/75. The ranking genuinely reorders between them. The prices
themselves are always shown in full, so only the last column changes.

**Only models that can call tools.** On by default, because a model that cannot call a tool cannot run
an agent. Models whose provider does not say either way are always shown rather than guessed at.

### Hiding a provider for a moment

The coloured dots under the heading are buttons. Press one and that provider's models drop out of the
table and its dot goes hollow; press it again and they come back. This is instant and does not touch
the network — it is for narrowing the table while you compare two providers. Use the settings switches
to say which providers you care about. Hiding is forgotten when you close the window.

## Reading the table

Prices are US dollars per million tokens, written input first. An em dash means the provider did not
publish that fact, not that the answer is no — a third of the models in the catalog do not state
whether they support structured output.

The relative column divides each model's blended price by the cheapest one currently on screen, so the
cheapest always reads `1.0×` and the rest say how many times more they cost. It is computed over what
you can see: switching a provider off, hiding it or searching moves the baseline. Models that are
genuinely free say **Free**.

Press a row — or a card, in a narrow window — and the provider's own page for that model opens, where
the description, the licence and the vendor's own price live.

In a narrow window the ten columns become one card per model — the same information, laid out to be
read rather than scanned across.

## Where prices are kept

Fetched prices are kept in bb's plugin storage, one entry per source, and reused for twelve hours.
**Refresh** ignores that and asks again. The refresh is cheap: models.dev supports conditional
requests, so an unchanged catalog costs a single round trip rather than a 4.7 MB download.

If one source cannot be reached, the page keeps showing the last prices it has for it, with a note
saying so and how old they are, and the other source's rows are unaffected.

## Limitations

- **The prices are only as current as their source.** models.dev is community-maintained, so a price
  change at Anthropic or OpenAI reaches this table when somebody updates the catalog, not when the
  vendor announces it. Each provider's own pricing page remains the authority; this table is for
  comparing, not for billing.
- **Only per-token prices are shown.** Cached input, batch discounts, image and audio pricing, and
  minimum charges are not in the table.
- **A model that appears twice is not a bug.** With OpenRouter on, a model sold both directly and
  through the gateway is two rows with two prices.
- **A model's link is worked out from its name**, because no catalog publishes one. A provider that
  retires a page or files a new model somewhere unexpected can leave a row pointing at a page that no
  longer exists.
- **"Ollama" here means Ollama Cloud**, the hosted models with real per-token prices — not the models
  pulled onto your own machine.
- **Prices are not shown in bb's model chooser.** bb gives plugins no way to add to it yet.
