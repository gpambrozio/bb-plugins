/**
 * The captain's settings, rendered by bb as a form (`bb.settings.define(SETTINGS)`). Settings changes do
 * not reload the plugin; read them with `get()` when needed, or subscribe with `onChange`.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { PluginSettingDescriptor, PluginSettingsValues } from "@get-bb/plugin-sdk";

import type { HomeConfig } from "./home";

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
} satisfies Record<string, PluginSettingDescriptor>;

export type FirstmateSettings = PluginSettingsValues<typeof SETTINGS>;

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
