// @vitest-environment jsdom
/** The settings section for the agent's instructions, against a fake server. */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_INSTRUCTIONS, normalizeInstructions } from "../shared/agent";
import type { RpcContract } from "../shared/contract";
import { AgentInstructionsSection } from "./agent-instructions-section";

afterEach(cleanup);

function server(initial: string | null = null) {
  const state = { text: initial, saves: [] as (string | null)[] };
  const rpc = {
    agentInstructions: () => ({ text: state.text }),
    setAgentInstructions: ({ text }: { text: string | null }) => {
      state.saves.push(text);
      state.text = normalizeInstructions(text);
      return { text: state.text };
    },
  };
  return { state, rpc };
}

function field(): Promise<HTMLTextAreaElement> {
  return screen.findByLabelText("Agent instructions") as Promise<HTMLTextAreaElement>;
}

describe("AgentInstructionsSection", () => {
  it("shows the built-in text, the line the plugin always adds and the placeholders, with nothing to save or restore", async () => {
    const { rpc } = server();
    renderSlot<object, RpcContract>({ component: AgentInstructionsSection }, {}, { rpc: rpc as never });
    expect((await field()).value).toBe(DEFAULT_INSTRUCTIONS);
    expect(screen.getByText(/This chat is attached to the user's terminal tab \{\{tab\}\} on the machine \{\{machine\}\}/)).toBeTruthy();
    expect(screen.getByText(/become the tab's name and its machine's/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Restore the built-in instructions" })).toBeNull();
  });

  it("saves an edited text, and restores the built-in one", async () => {
    const { state, rpc } = server();
    renderSlot<object, RpcContract>({ component: AgentInstructionsSection }, {}, { rpc: rpc as never });
    fireEvent.change(await field(), { target: { value: `${DEFAULT_INSTRUCTIONS}\n\nAnswer in French.` } });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(state.text).toBe(`${DEFAULT_INSTRUCTIONS}\n\nAnswer in French.`));
    expect(await screen.findByText("Saved.")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Restore the built-in instructions" }));
    await waitFor(() => expect(state.text).toBeNull());
    expect(state.saves.at(-1)).toBeNull();
    expect((await field()).value).toBe(DEFAULT_INSTRUCTIONS);
    expect(await screen.findByText("Using the built-in instructions.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore the built-in instructions" })).toBeNull();
  });

  it("starts on the owner's saved text", async () => {
    const { rpc } = server("Be brief.");
    renderSlot<object, RpcContract>({ component: AgentInstructionsSection }, {}, { rpc: rpc as never });
    expect((await field()).value).toBe("Be brief.");
    expect(screen.getByRole("button", { name: "Restore the built-in instructions" })).toBeTruthy();
  });
});
