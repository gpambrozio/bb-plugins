/**
 * The five providers this plugin prices, and which upstream each one is read
 * from. Plain values, so both halves import it: the server maps requested
 * provider ids to the sources it has to fetch, the client draws the labels and
 * the legend.
 *
 * Only two upstreams exist, because only two publish prices without a key:
 *
 * - **models.dev** (`https://models.dev/api.json`) is a community catalog whose
 *   model shape is exactly the columns this table wants — context, max output,
 *   input/output cost, and the four capability flags. It is the only public
 *   source of Anthropic, OpenAI and Fireworks prices at all: each of those
 *   vendors' own `GET /v1/models` needs an API key *and* returns no prices.
 * - **OpenRouter** (`https://openrouter.ai/api/v1/models`) publishes its own,
 *   unauthenticated and live. models.dev mirrors it too, but a few dozen models
 *   behind, so the table reads it first-hand.
 *
 * Adding a provider is a row here plus, if it is not on models.dev, a fetcher
 * and a normalizer in `server/`.
 */

/** An upstream the server fetches. One fetch and one cache entry per source. */
export const SOURCE_IDS = ["models-dev", "openrouter"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * A provider's identity colour, in a dark-background and a light-background
 * variant.
 *
 * **This is the one place in the plugin that does not take a colour from bb's
 * theme classes, and it is deliberate.** bb's semantic colours carry meaning —
 * `text-destructive`, `text-success`, `text-warning-text` — and there are not
 * five neutral hues among them to tell five providers apart. Painting Anthropic
 * "destructive" is a sentence about Anthropic, not a label. (In Paseo a theme
 * token was tried first and shipped two providers in the same green.)
 *
 * So the five hues are spread around the wheel — orange, green, violet, blue,
 * pink — and each is given two values: a bright one that reads on a dark
 * background and a darker one that reads on a light one. `pickAccent` chooses
 * between them from bb's own light/dark mode.
 */
export interface ProviderAccent {
  /** Used on a dark background: bright enough to read as text on it. */
  readonly dark: string;
  /** Used on a light background: dark enough to read as text on it. */
  readonly light: string;
}

export interface ProviderInfo {
  /** This plugin's own id. Stable: it is the key of its switch in the settings. */
  readonly id: string;
  readonly label: string;
  readonly source: SourceId;
  /**
   * models.dev's key for this provider, or `null` when the provider has its own
   * fetcher. Note `fireworks-ai` and `ollama-cloud` — the keys are not the ids.
   */
  readonly catalogKey: string | null;
  readonly accent: ProviderAccent;
  /** Where a human checks the number this table shows. */
  readonly doc: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    source: "models-dev",
    catalogKey: "anthropic",
    accent: { dark: "#f0916a", light: "#c2410c" },
    doc: "https://www.anthropic.com/pricing",
  },
  {
    id: "openai",
    label: "OpenAI",
    source: "models-dev",
    catalogKey: "openai",
    accent: { dark: "#4ecf9a", light: "#0f766e" },
    doc: "https://openai.com/api/pricing/",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    source: "models-dev",
    catalogKey: "fireworks-ai",
    accent: { dark: "#a78bfa", light: "#6d28d9" },
    doc: "https://fireworks.ai/pricing",
  },
  {
    id: "ollama",
    label: "Ollama Cloud",
    source: "models-dev",
    catalogKey: "ollama-cloud",
    accent: { dark: "#5aa9f0", light: "#1d4ed8" },
    doc: "https://docs.ollama.com/cloud",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    source: "openrouter",
    catalogKey: null,
    accent: { dark: "#e879b9", light: "#be185d" },
    doc: "https://openrouter.ai/models",
  },
];

export const PROVIDER_IDS: readonly string[] = PROVIDERS.map((provider) => provider.id);

export function providerById(id: string): ProviderInfo | null {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function providerLabel(id: string): string {
  return providerById(id)?.label ?? id;
}

/**
 * Which upstreams have to be fetched to answer for these providers. Four of the
 * five share `models-dev`, so switching Anthropic off saves a fetch only once
 * OpenAI, Fireworks and Ollama Cloud are off too.
 */
export function sourcesFor(providerIds: readonly string[]): SourceId[] {
  const needed = new Set<SourceId>();
  for (const id of providerIds) {
    const provider = providerById(id);
    if (provider !== null) needed.add(provider.source);
  }
  return SOURCE_IDS.filter((source) => needed.has(source));
}

/** The provider ids served by one source, in catalog order. */
export function providersOfSource(source: SourceId): readonly ProviderInfo[] {
  return PROVIDERS.filter((provider) => provider.source === source);
}

/** bb's appearance: `experimental_useCodeTheme().mode` in the app. */
export type ColorMode = "dark" | "light";

/**
 * Whether a `#rrggbb` colour is dark, by perceived brightness (Rec. 601 luma:
 * green carries most of what the eye reads as brightness). Anything else is
 * treated as dark. The palette test uses it to keep each pair the right way
 * round.
 */
export function isDarkColor(color: string): boolean {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return true;
  const red = parseInt(color.slice(1, 3), 16);
  const green = parseInt(color.slice(3, 5), 16);
  const blue = parseInt(color.slice(5, 7), 16);
  return (red * 0.299 + green * 0.587 + blue * 0.114) / 255 < 0.5;
}

/** A provider's colour for bb's current appearance. */
export function pickAccent(accent: ProviderAccent, mode: ColorMode): string {
  return mode === "dark" ? accent.dark : accent.light;
}
