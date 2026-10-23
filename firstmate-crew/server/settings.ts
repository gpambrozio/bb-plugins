/**
 * The captain's settings, rendered by bb as a form (`bb.settings.define(SETTINGS)`). Settings changes do
 * not reload the plugin; read them with `get()` when needed, or subscribe with `onChange`.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { PluginSettingDescriptor, PluginSettingsValues } from "@get-bb/plugin-sdk";
import { z } from "zod";

import type { HomeConfig } from "./home";

/** A token count or a number of minutes: a whole number above zero. */
const POSITIVE_WHOLE = z.number().int("Use a whole number.").positive("Use a number above zero.");

/** The autocompact settings' defaults: off, above 200 thousand tokens, after 60 idle minutes. */
export const AUTOCOMPACT_DEFAULTS = { enabled: false, kTokens: 200, idleMinutes: 60 } as const;

/**
 * The token thresholds are set in thousands of tokens: bb's number field shows no thousands separators,
 * and 200 reads more easily than 200000.
 */
const TOKENS_PER_K = 1_000;

export const REASONING_OPTIONS = ["default", "low", "medium", "high", "xhigh", "max"];

export const SETTINGS = {
  homeDirectory: {
    type: "string",
    label: "Home directory",
    description:
      "Where the first mate keeps its charter and records. An absolute path, or one starting with ~. Registered as the FirstMate project on launch.",
    default: "~/FirstMate",
  },
  crewProvider: {
    type: "string",
    label: "Crew provider",
    description: "The provider crewmates are started with, such as claude-code or codex. Empty leaves it to the first mate.",
    default: "",
  },
  crewModel: {
    type: "string",
    label: "Crew model",
    description: "The model crewmates are started with. Used only together with a crew provider.",
    default: "",
  },
  crewReasoning: {
    type: "select",
    label: "Crew reasoning",
    description: "Reasoning effort for crewmates. Default leaves it to the first mate.",
    options: REASONING_OPTIONS,
    default: "default",
  },
  refreshSeconds: {
    type: "number",
    label: "Board refresh (seconds)",
    description: "How often the board reloads the crew while it is open.",
    default: 10,
  },
  mateAutoCompact: {
    type: "boolean",
    label: "First mate: compact when idle",
    description:
      "Compact the first mate's conversation once it has been idle for a while with a large context, so its next turn does not resend all of it.",
    default: AUTOCOMPACT_DEFAULTS.enabled,
  },
  mateAutoCompactKTokens: {
    type: "number",
    label: "First mate: compact above (thousand tokens, k)",
    description: "Compact only when the first mate's context holds more than this many thousand tokens: 200 means 200,000 tokens.",
    experimental_schema: POSITIVE_WHOLE,
    default: AUTOCOMPACT_DEFAULTS.kTokens,
  },
  mateAutoCompactIdleMinutes: {
    type: "number",
    label: "First mate: compact after idle (minutes)",
    description:
      "How long after its last turn ended the first mate is compacted. Nothing is compacted mid-turn, with a message queued, or while waiting on an answer.",
    experimental_schema: POSITIVE_WHOLE,
    default: AUTOCOMPACT_DEFAULTS.idleMinutes,
  },
  crewAutoCompact: {
    type: "boolean",
    label: "Crew: compact when idle",
    description: "Compact each crewmate's conversation once it has been idle for a while with a large context. Ended crewmates are left alone.",
    default: AUTOCOMPACT_DEFAULTS.enabled,
  },
  crewAutoCompactKTokens: {
    type: "number",
    label: "Crew: compact above (thousand tokens, k)",
    description: "Compact a crewmate only when its context holds more than this many thousand tokens: 200 means 200,000 tokens.",
    experimental_schema: POSITIVE_WHOLE,
    default: AUTOCOMPACT_DEFAULTS.kTokens,
  },
  crewAutoCompactIdleMinutes: {
    type: "number",
    label: "Crew: compact after idle (minutes)",
    description:
      "How long after its last turn ended a crewmate is compacted. Nothing is compacted mid-turn, with a message queued, or while waiting on an answer.",
    experimental_schema: POSITIVE_WHOLE,
    default: AUTOCOMPACT_DEFAULTS.idleMinutes,
  },
} satisfies Record<string, PluginSettingDescriptor>;

export type FirstmateSettings = PluginSettingsValues<typeof SETTINGS>;

/** Every setting at its default, as bb reports them before the captain changes any. */
export function defaultSettings(): FirstmateSettings {
  const entries = Object.entries(SETTINGS).map(([key, descriptor]) => [key, descriptor.default]);
  return Object.fromEntries(entries) as FirstmateSettings;
}

/** The home directory setting as an absolute path: a leading `~` is the user's home directory. */
export function homePath(setting: string): string {
  const value = setting.trim();
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (isAbsolute(value)) return value;
  throw new Error(`Home directory must be an absolute path or start with ~: ${setting}`);
}

/** What the charter says about the crew: `provider/model` only when both are set, and no reasoning for "default". */
export function homeConfig(settings: FirstmateSettings): HomeConfig {
  const provider = settings.crewProvider.trim();
  const model = settings.crewModel.trim();
  return {
    crewProvider: provider !== "" && model !== "" ? `${provider}/${model}` : "",
    crewReasoning: settings.crewReasoning === "default" ? "" : settings.crewReasoning,
  };
}

/** When one kind of thread is compacted on its own: switched on, above `minTokens` tokens, `idleMinutes` after its last turn. */
export interface AutoCompactRule {
  enabled: boolean;
  minTokens: number;
  idleMinutes: number;
}

export interface AutoCompactRules {
  mate: AutoCompactRule;
  crew: AutoCompactRule;
}

/** The six autocompact settings as one rule for the first mate and one for its crew, thresholds in tokens. */
export function autoCompactRules(settings: FirstmateSettings): AutoCompactRules {
  return {
    mate: {
      enabled: settings.mateAutoCompact,
      minTokens: settings.mateAutoCompactKTokens * TOKENS_PER_K,
      idleMinutes: settings.mateAutoCompactIdleMinutes,
    },
    crew: {
      enabled: settings.crewAutoCompact,
      minTokens: settings.crewAutoCompactKTokens * TOKENS_PER_K,
      idleMinutes: settings.crewAutoCompactIdleMinutes,
    },
  };
}
