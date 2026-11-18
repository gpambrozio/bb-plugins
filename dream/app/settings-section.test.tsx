// @vitest-environment jsdom
/**
 * The settings section always says which model and reasoning level are saved, and saves a model only
 * when the user presses Save. bb's model picker changes its own selection, and calls onChange, when the
 * saved model is not one the machine's Claude Code lists (on mount, on a rerender, on a machine change);
 * saving that would overwrite the user's choice just by opening the settings, and showing only the
 * picker would hide what dreams use. The picker is replaced by one that does exactly that.
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
  experimental_ProviderModelPicker: function NormalizingPicker({
    value,
    onChange,
  }: {
    value: { providerId: string; model: string; reasoningLevel: string };
    onChange(value: { providerId: string; model: string; reasoningLevel: string }): void;
  }) {
    // As bb's picker does when the saved model is not in this Claude Code's list: it picks the nearest
    // one it has, on every render that shows the unlisted one.
    useEffect(() => {
      if (value.model === "claude-opus-5-5" && value.reasoningLevel === "high") onChange({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "low" });
    });
    return (
      <div>
        <p data-testid="picker-shows">
          {value.model} {value.reasoningLevel}
        </p>
        <button type="button" onClick={() => onChange({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "medium" })}>
          Pick Sonnet
        </button>
      </div>
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

const saved: Choices = { hostId: null, model: "claude-opus-5-5", reasoningLevel: "high" };

function render(saves: Array<Partial<Choices>>) {
  let choices = saved;
  return renderSlot<object, RpcContract>({ component: DreamSettingsSection }, {}, {
    rpc: {
      overview: () => ({ ...overview, choices }),
      setChoices: (changes) => {
        saves.push(changes);
        choices = { ...choices, ...changes };
        return choices;
      },
    } as Partial<PluginRpcTestHandlers<RpcContract>> as PluginRpcTestHandlers<RpcContract>,
  });
}

describe("the model setting", () => {
  it("shows the saved model and reasoning level exactly, even when the picker shows another, and saves nothing on its own", async () => {
    const saves: Array<Partial<Choices>> = [];
    const view = render(saves);
    await waitFor(() => expect(screen.getByTestId("picker-shows").textContent).toBe("claude-opus-5-5 low"));
    expect(screen.getByTestId("dream-saved-model").textContent).toBe("Saved: claude-opus-5-5, high reasoning");
    expect(screen.getByText(/Not saved\. The picker shows/)).toBeTruthy();

    view.rerender(<DreamSettingsSection />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saves).toEqual([]);
    expect(screen.getByTestId("dream-saved-model").textContent).toBe("Saved: claude-opus-5-5, high reasoning");
  });

  it("saves the user's pick only when they press Save, then shows it as saved", async () => {
    const saves: Array<Partial<Choices>> = [];
    render(saves);
    fireEvent.click(await screen.findByRole("button", { name: "Pick Sonnet" }));
    expect(screen.getByTestId("picker-shows").textContent).toBe("claude-sonnet-5-5 medium");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saves).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save claude-sonnet-5-5, medium reasoning" }));
    await waitFor(() => expect(saves).toEqual([{ model: "claude-sonnet-5-5", reasoningLevel: "medium" }]));
    await waitFor(() => expect(screen.getByTestId("dream-saved-model").textContent).toBe("Saved: claude-sonnet-5-5, medium reasoning"));
    expect(screen.queryByText(/Not saved/)).toBeNull();
  });
});
