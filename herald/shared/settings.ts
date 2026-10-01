/**
 * The settings bb renders as a form (`bb.settings.define(SETTINGS)`), and how
 * each half reads them: the server for what to announce, the app — through
 * `useSettings()` — for how and where to speak. Settings changes do not reload
 * the plugin; both halves read the current values when they act.
 *
 * Only a type is imported from the SDK, so the app may import this module.
 */
import type { PluginSettingDescriptor, PluginSettingsValues } from "@get-bb/plugin-sdk";

import { RATE_OPTIONS, SPEECH_ENGINES, type SpeechEngine } from "./herald";

export const SETTINGS = {
  speak: {
    type: "boolean",
    label: "Speak announcements",
    description: "The master switch. Off, nothing is spoken on any device; the Herald panel still lists what is waiting.",
    default: true,
  },
  speakOnDesktop: {
    type: "boolean",
    label: "Speak in the desktop app",
    description: "The bb desktop app speaks as soon as an agent needs you.",
    default: true,
  },
  speakInBrowser: {
    type: "boolean",
    label: "Speak in a browser tab",
    description: "A browser tab speaks only after you have pressed Test voice in the Herald panel once, since browsers block sound until a page is tapped.",
    default: true,
  },
  speakOnMobile: {
    type: "boolean",
    label: "Speak in the mobile app",
    description:
      "The bb mobile app speaks while it is open on screen, after one tap of Test voice. A locked or backgrounded phone hears nothing; bb's push notifications reach it instead.",
    default: false,
  },
  engine: {
    type: "select",
    label: "Voice source",
    description:
      "say: the voices of the Mac running bb, rendered there and played on this device. web: this device's own browser voice. say falls back to web when bb does not run on a Mac.",
    options: [...SPEECH_ENGINES],
    default: "say",
  },
  rate: {
    type: "select",
    label: "Speech rate",
    description: "A multiplier on the voice's own pace.",
    options: [...RATE_OPTIONS],
    default: "1",
  },
  announceQuestions: {
    type: "boolean",
    label: "Announce questions",
    description: "An agent asks you something. Switched off, the thread is still listed in the panel, without being spoken.",
    default: true,
  },
  announcePlans: {
    type: "boolean",
    label: "Announce plans",
    description: "An agent waits for you to approve its plan.",
    default: true,
  },
  announcePermissions: {
    type: "boolean",
    label: "Announce permissions",
    description: "An agent waits for your approval to run a command, change files or use a tool.",
    default: true,
  },
  announceFinished: {
    type: "boolean",
    label: "Announce finished turns",
    description: "An agent finished its turn and is waiting for you.",
    default: true,
  },
  announceErrors: {
    type: "boolean",
    label: "Announce errors",
    description: "An agent's turn failed.",
    default: true,
  },
  announceSubagents: {
    type: "boolean",
    label: "Announce threads started by another thread",
    description:
      "Off: a child thread reports to the thread that started it, and you hear the parent's announcement instead of two. It is still listed in the panel. On: both are announced.",
    default: false,
  },
} satisfies Record<string, PluginSettingDescriptor>;

export type HeraldSettings = PluginSettingsValues<typeof SETTINGS>;

/** Where this copy of the app runs, which decides the switch that applies to it. */
export type SpeechPlatform = "desktop" | "browser" | "mobile";

/** How to speak, as the app needs it: the host form's values with their defaults filled in. */
export interface SpeechSettings {
  speak: boolean;
  speakOnDesktop: boolean;
  speakInBrowser: boolean;
  speakOnMobile: boolean;
  engine: SpeechEngine;
  rate: number;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** `useSettings().values` is undefined while loading and loosely typed; this reads it safely. */
export function speechSettingsOf(values: Record<string, string | number | boolean> | undefined): SpeechSettings {
  const engine = values?.engine;
  const rate = Number(values?.rate ?? SETTINGS.rate.default);
  return {
    speak: flag(values?.speak, SETTINGS.speak.default),
    speakOnDesktop: flag(values?.speakOnDesktop, SETTINGS.speakOnDesktop.default),
    speakInBrowser: flag(values?.speakInBrowser, SETTINGS.speakInBrowser.default),
    speakOnMobile: flag(values?.speakOnMobile, SETTINGS.speakOnMobile.default),
    engine: engine === "web" ? "web" : "say",
    rate: Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : 1,
  };
}

/**
 * Why this device stays quiet, or null when it may speak. One function for
 * every caller: an announcement that is blocked is dropped silently, a pressed
 * control shows the reason — a switch the user set has to mean what it says,
 * and a control that simply did nothing could not explain itself.
 */
export function blockedMessage(settings: SpeechSettings, platform: SpeechPlatform, mutedHere: boolean): string | null {
  if (mutedHere) return "Herald is muted on this device. Unmute it from the Herald panel.";
  if (!settings.speak) return "Announcements are off in Herald's settings.";
  switch (platform) {
    case "desktop":
      return settings.speakOnDesktop ? null : "Speaking in the desktop app is off in Herald's settings.";
    case "browser":
      return settings.speakInBrowser ? null : "Speaking in a browser tab is off in Herald's settings.";
    case "mobile":
      return settings.speakOnMobile ? null : "Speaking in the mobile app is off in Herald's settings.";
  }
}
