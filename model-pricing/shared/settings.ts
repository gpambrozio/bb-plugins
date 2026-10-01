/**
 * The settings bb renders as a form (`bb.settings.define(SETTINGS)`), and how
 * the app reads them back through `useSettings()`.
 *
 * Every value here is one the *app* reads — which providers to show, how to
 * weight the relative-cost column, whether to hide models that cannot call
 * tools. The server reads none of them.
 *
 * "Which providers to refresh" is the same switch as "which providers to show":
 * the panel passes the enabled ids into `load`, and the server fetches only the
 * sources those need. A provider switched off is genuinely not fetched, so no
 * server-side copy of the list has to exist.
 *
 * Only a type is imported from the SDK, so the app may import this module.
 */
import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";

import { PROVIDERS } from "./providers";

/**
 * How much of the blended price is input; the rest is output. Picked from a
 * list rather than typed, because a free number would imply a precision the
 * ranking does not have. The option *is* its label in bb's form, so it reads
 * as the split itself.
 *
 * There is no single right answer, which is why it is a setting: an agent that
 * reads a large repository and writes a patch is mostly input, a chat that
 * drafts prose is mostly output, and the ranking genuinely reorders between the
 * two. 80/20 is the default because agent workloads skew heavily to input.
 */
export const INPUT_WEIGHTS = ["100/0", "80/20", "75/25", "50/50", "25/75", "0/100"] as const;
export type InputWeight = (typeof INPUT_WEIGHTS)[number];
export const DEFAULT_WEIGHT: InputWeight = "80/20";

/** Why a user might care that a provider is on, beyond its name. */
const PROVIDER_HINTS: Record<string, string> = {
  anthropic: "Claude models, from the models.dev catalog.",
  openai: "GPT models, from the models.dev catalog.",
  fireworks: "Open-weight models hosted by Fireworks, from the models.dev catalog.",
  ollama: "The models Ollama hosts in its cloud, not the ones pulled on this machine. From the models.dev catalog.",
  openrouter: "Several hundred models from one gateway, read live from OpenRouter itself.",
};

/**
 * One switch per provider, keyed by the provider's id. A provider switched off
 * is not fetched and not shown. All five are on to begin with.
 */
const PROVIDER_SETTINGS = Object.fromEntries(
  PROVIDERS.map((provider) => [
    provider.id,
    {
      type: "boolean",
      label: provider.label,
      description: `${PROVIDER_HINTS[provider.id] ?? provider.doc} Off: not fetched and not shown.`,
      default: true,
    } satisfies PluginSettingDescriptor,
  ]),
) as Record<string, PluginSettingDescriptor>;

export const SETTINGS = {
  ...PROVIDER_SETTINGS,
  inputWeight: {
    type: "select",
    label: "Input / output blend",
    description:
      "How much of each model's relative cost is its input price. 80/20 suits an agent that reads a repository and writes a patch; a chat that drafts prose is closer to 25/75. Only the Relative column changes — prices are always shown in full.",
    options: [...INPUT_WEIGHTS],
    default: DEFAULT_WEIGHT,
  },
  toolCallOnly: {
    type: "boolean",
    label: "Only models that can call tools",
    description:
      "A model that cannot call a tool cannot run an agent. Models whose provider does not say either way are always shown.",
    default: true,
  },
} satisfies Record<string, PluginSettingDescriptor>;

/** What the panel draws with, parsed out of the raw settings values. */
export interface Display {
  /** Enabled provider ids this build knows about, in catalog order. */
  providers: string[];
  inputWeight: InputWeight;
  toolCallOnly: boolean;
}

export const DEFAULT_DISPLAY: Display = {
  providers: PROVIDERS.map((provider) => provider.id),
  inputWeight: DEFAULT_WEIGHT,
  toolCallOnly: true,
};

/**
 * `useSettings().values` is untrusted: missing while loading, and a stored
 * value may predate an option list. Anything unreadable takes its default
 * rather than blocking the table — a broken setting should cost the user that
 * choice, not the whole panel.
 */
export function displayFrom(values: Readonly<Record<string, unknown>> | undefined): Display {
  if (values === undefined) return DEFAULT_DISPLAY;
  const weight = values["inputWeight"];
  return {
    providers: PROVIDERS.filter((provider) => values[provider.id] !== false).map((provider) => provider.id),
    inputWeight: INPUT_WEIGHTS.find((option) => option === weight) ?? DEFAULT_WEIGHT,
    toolCallOnly: values["toolCallOnly"] !== false,
  };
}

/** The input share of the blended price, as a fraction. Output takes the rest. */
export function inputShare(weight: InputWeight): number {
  return Number(weight.split("/")[0]) / 100;
}
