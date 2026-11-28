// @vitest-environment jsdom
/**
 * The Voice page's review of the voice's staged instructions edit: the diff, and Apply, Tweak then Apply tweak,
 * and Reject, each sent with the id of the edit on screen. A newer edit that replaces it shows at once, with a
 * note; the sidebar entry wears a pencil while one waits.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { rpcContract } from "../server";
import { PROMPT_EDIT_TAG, type StagedEdit } from "../shared/prompt-edit";
import { PromptEditCard } from "./prompt-edit";
import { PENCIL, WAITING_LABEL, stagedNotes, withPencil } from "./prompt-edit-view";

type Rpc = PluginRpcTestHandlers<typeof rpcContract>;

const NOW = "You are Voice Pilot.\n\nStyle: speak briefly.";

function edit(overrides: Partial<StagedEdit> = {}): StagedEdit {
  return { id: "edit_1", proposed: `${NOW}\n\nCall the user Sam.`, base: NOW, summary: "Call the user Sam", stagedAt: Date.now(), replaced: null, ...overrides };
}

/** The server as far as the card can tell: one staged edit (or none), and what apply and reject were sent. */
function server(initial: StagedEdit | null) {
  const state = { staged: initial, current: NOW };
  const applied: { id: string; text?: string }[] = [];
  const rejected: string[] = [];
  const rpc = {
    "prompt.staged": async () => ({ staged: state.staged, current: state.current }),
    "prompt.apply": async ({ id, text }: { id: string; text?: string }) => {
      if (state.staged?.id !== id) throw new Error("A newer instructions edit replaced this one. Review the new one.");
      applied.push(text === undefined ? { id } : { id, text });
      state.current = text ?? state.staged.proposed;
      state.staged = null;
      return { applied: true as const };
    },
    "prompt.reject": async ({ id }: { id: string }) => {
      rejected.push(id);
      state.staged = null;
      return null;
    },
  } as Partial<Rpc> as Rpc;
  return { state, applied, rejected, rpc };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the sidebar badge", () => {
  it("is a pencil while an edit waits, after the session's own badge when there is one", () => {
    expect(withPencil(null, false)).toBeNull();
    expect(withPencil(null, true)).toEqual({ text: PENCIL, tone: "warning", label: WAITING_LABEL });
    expect(withPencil({ text: "Live", tone: "neutral", label: "Voice Pilot is listening" }, true)).toEqual({
      text: `Live ${PENCIL}`,
      tone: "neutral",
      label: `Voice Pilot is listening. ${WAITING_LABEL}`,
    });
    expect(withPencil({ text: "Paused", tone: "neutral", label: "p" }, true)?.text).toHaveLength(8);
  });
});

describe("the notes beside the diff", () => {
  it("say what the edit replaced, and when the instructions moved since it was made", () => {
    expect(stagedNotes(edit(), NOW)).toEqual([]);
    const notes = stagedNotes(edit({ replaced: { summary: "Shorter greeting", stagedAt: Date.now() }, base: "older" }), NOW);
    expect(notes[0]).toMatch(/^This replaced the edit proposed at .* \(“Shorter greeting”\), which was dropped: one edit waits at a time\.$/u);
    expect(notes[1]).toMatch(/changed since this was proposed/u);
  });
});

describe("the review card", () => {
  it("shows nothing while no edit waits", async () => {
    const { rpc } = server(null);
    const view = renderSlot({ component: PromptEditCard }, {}, { rpc });
    await act(async () => undefined);
    expect(view.container.textContent).toBe("");
  });

  it("shows the edit's summary and its diff, and applies it as staged", async () => {
    const { rpc, applied } = server(edit());
    renderSlot({ component: PromptEditCard }, {}, { rpc });
    await screen.findByText("Call the user Sam");
    expect(screen.getByText(/2 added, 0 removed/u)).toBeTruthy();
    expect(screen.getByText(/takes effect from the next voice session/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Applied. The next voice session starts with the new instructions.");
    expect(applied).toEqual([{ id: "edit_1" }]);
  });

  it("applies the owner's tweak instead, after editing the proposed text", async () => {
    const { rpc, applied } = server(edit());
    renderSlot({ component: PromptEditCard }, {}, { rpc });
    fireEvent.click(await screen.findByRole("button", { name: "Tweak" }));
    const box = screen.getByRole("textbox", { name: "Tweak the proposed instructions" }) as HTMLTextAreaElement;
    expect(box.value).toBe(`${NOW}\n\nCall the user Sam.`);
    fireEvent.change(box, { target: { value: `${NOW}\n\nCall the user Samantha.` } });
    expect(screen.getByText(/2 added, 0 removed/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply tweak" }));
    await screen.findByText("Applied your tweak. The next voice session starts with it.");
    expect(applied).toEqual([{ id: "edit_1", text: `${NOW}\n\nCall the user Samantha.` }]);
  });

  it("cancels a tweak back to the edit as staged, and does not apply an empty one", async () => {
    const { rpc, applied } = server(edit());
    renderSlot({ component: PromptEditCard }, {}, { rpc });
    fireEvent.click(await screen.findByRole("button", { name: "Tweak" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Apply tweak" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(applied).toEqual([]);
  });

  it("rejects it, leaving the instructions as they were", async () => {
    const { rpc, rejected, applied, state } = server(edit());
    renderSlot({ component: PromptEditCard }, {}, { rpc });
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await screen.findByText("Rejected. The instructions stay as they were.");
    expect(rejected).toEqual(["edit_1"]);
    expect(applied).toEqual([]);
    expect(state.current).toBe(NOW);
  });

  it("swaps in a newer edit as soon as it is staged, setting a tweak aside and saying so", async () => {
    const { rpc, state, applied } = server(edit());
    const view = renderSlot({ component: PromptEditCard }, {}, { rpc });
    fireEvent.click(await screen.findByRole("button", { name: "Tweak" }));
    state.staged = edit({ id: "edit_2", proposed: `${NOW}\n\nBe short.`, summary: "Be short", replaced: { summary: "Call the user Sam", stagedAt: Date.now() } });
    await view.experimental_invalidateRpc([PROMPT_EDIT_TAG]);
    await screen.findByText("Be short");
    expect(screen.getByText(/A newer edit replaced the one you were tweaking/u)).toBeTruthy();
    expect(screen.getByText(/This replaced the edit proposed at .*Call the user Sam/u)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applied).toEqual([{ id: "edit_2" }]));
  });

  it("says why when the server refuses", async () => {
    const { rpc, state } = server(edit());
    renderSlot({ component: PromptEditCard }, {}, { rpc });
    await screen.findByText("Call the user Sam");
    state.staged = edit({ id: "edit_9" });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/A newer instructions edit replaced this one/u);
  });
});
