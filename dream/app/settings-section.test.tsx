// @vitest-environment jsdom
/**
 * The settings section saves only the model the user picks. bb's model picker calls onChange by itself
 * when the stored model is not one the machine's Claude Code lists; saving that would overwrite the
 * user's choice just by opening the settings. The picker is replaced by one that does exactly that.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_CHOICES, type Choices, type Overview } from "../shared/contract-types";
import { DreamSettingsSection } from "./settings-section";

vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_ProviderModelPicker: function NormalizingPicker({ onChange }: { onChange(value: { providerId: string; model: string; reasoningLevel: string }): void }) {
    // As bb's picker does when the stored model is not in this Claude Code's list.
    useEffect(() => onChange({ providerId: "claude-code", model: "opus", reasoningLevel: "high" }), []);
    return (
      <button type="button" onClick={() => onChange({ providerId: "claude-code", model: "sonnet", reasoningLevel: "medium" })}>
        Pick Sonnet
      </button>
    );
  },
}));

afterEach(() => cleanup());

const overview: Overview = {
  host: { id: "host_1", name: "Studio", connected: true },
  hosts: [{ id: "host_1", name: "Studio", connected: true }],
  choices: DEFAULT_CHOICES,
  schedule: { enabled: false, windowStart: "01:00", windowEnd: "06:00", inWindow: false, nextChange: null, lastSweepAt: null },
  alwaysDryRun: false,
  active: null,
  error: null,
  projects: [],
};

describe("the model setting", () => {
  it("is never saved by the picker on its own, only when the user picks one", async () => {
    const saved: Array<Partial<Choices>> = [];
    renderSlot<object, RpcContract>({ component: DreamSettingsSection }, {}, {
      rpc: {
        overview: () => overview,
        setChoices: (changes) => {
          saved.push(changes);
          return { ...DEFAULT_CHOICES, ...changes };
        },
      } as Partial<PluginRpcTestHandlers<RpcContract>> as PluginRpcTestHandlers<RpcContract>,
    });
    const pick = await screen.findByRole("button", { name: "Pick Sonnet" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saved).toEqual([]);

    fireEvent.pointerDown(pick);
    fireEvent.click(pick);
    await waitFor(() => expect(saved).toEqual([{ model: "sonnet", reasoningLevel: "medium" }]));
  });
});
