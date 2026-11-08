// @vitest-environment jsdom
/** The Learning tab's Orientation section: each state's named controls and the calls they make. */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract } from "../shared/contract";
import type { Orientation, OrientationSummary } from "../shared/orientation";
import { ORIENTATION_TAB_ID } from "./orientation-ids";
import { OrientationSection } from "./orientation-section";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(cleanup);

const WORK = "thr_work";
const PERMISSION = "A background agent reads this project for a few minutes in this checkout. bb gives it permission to read and edit files; it is told not to edit anything.";

const summary: OrientationSummary = {
  purpose: "A calculator library.",
  languages: ["TypeScript"],
  stages: ["parse", "evaluate"],
  keyFiles: Array.from({ length: 6 }, (_, i) => ({ path: `src/file${i}.ts`, does: `does ${i}`, why: `why ${i}` })),
  concepts: [{ name: "Token", definition: "A lexed unit.", where: "src/lex.ts" }, { name: "AST", definition: "A tree.", where: "src/ast.ts" }, { name: "Env", definition: "Bindings.", where: "src/env.ts" }],
  gotchas: ["Floats round.", "Order matters."],
  exercises: [{ file: "a.ts", read: "1-5", question: "q1" }, { file: "b.ts", read: "1-5", question: "q2" }],
  sources: ["src/file0.ts"],
};

function orientation(overrides: Partial<Orientation> = {}): Orientation {
  return {
    id: "ori_1",
    status: "ready",
    depth: "walkthrough",
    title: "calc",
    summary,
    blocks: 12,
    listings: 4,
    createdAt: 1_000,
    updatedAt: 2_000,
    readyAt: 2_000,
    error: null,
    headSha: "abc",
    workspace: { threadId: WORK, environmentId: "env_1", rootPath: "/work/calc" },
    ...overrides,
  };
}

type State = { current: Orientation | null; live: Orientation | null; last: Orientation | null; canStart: boolean; cleaning: boolean };

function render(state: Partial<State> = {}, extra: Record<string, (input: never) => unknown> = {}) {
  const full: State = { current: null, live: null, last: null, canStart: true, cleaning: false, ...state };
  return renderSlot({ component: OrientationSection }, { threadId: WORK, visible: true }, {
    rpc: {
      orientation: () => full,
      startOrientation: () => ({ orientationId: "ori_new" }),
      cancelOrientation: () => null,
      deleteOrientation: () => null,
      verifyOrientation: () => ({ checked: 4, drift: [] }),
      startOrientationSession: () => ({ threadId: "thr_orient" }),
      ...extra,
    } as never,
    experimental_rpcContract: rpcContract,
  });
}

describe("the Orientation section", () => {
  it("none: the start button, the walkthrough checkbox and the permission line", async () => {
    const slot = render();
    await screen.findByRole("button", { name: "Orient me to this project" });
    expect(screen.getByText(PERMISSION)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Orient me to this project" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "startOrientation")?.input).toEqual({ threadId: WORK, depth: "summary" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include a walkthrough" }));
    fireEvent.click(screen.getByRole("button", { name: "Orient me to this project" }));
    await waitFor(() => expect(slot.rpcCalls.filter((c) => c.method === "startOrientation").at(-1)?.input).toEqual({ threadId: WORK, depth: "walkthrough" }));
  });

  it("cleaning: says so and disables the start button", async () => {
    render({ cleaning: true });
    const button = await screen.findByRole("button", { name: "Orient me to this project" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/clean/i)).toBeTruthy();
  });

  it("live: a spinner, blocks and minutes, and Cancel", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000 + 3 * 60_000 + 5_000);
    const slot = render({ live: orientation({ id: "ori_live", status: "building", summary: null, blocks: 7, createdAt: 1_000, readyAt: null }) });
    const building = await screen.findByText("Building · 7 blocks · 3 min");
    const spinner = building.querySelector('[data-icon="Spinner"]');
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    expect(spinner?.getAttribute("class")).toContain("animate-spin");
    expect(spinner?.getAttribute("class")).toContain("motion-reduce:animate-none");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "cancelOrientation")?.input).toEqual({ orientationId: "ori_live" }));
    vi.restoreAllMocks();
  });

  it("ready: the summary, key files as links, and every button", async () => {
    const slot = render({ current: orientation() });
    await screen.findByText("A calculator library.");
    expect(document.querySelector('[data-icon="Spinner"]')).toBeNull();
    for (const name of ["Start orientation session", "Read walkthrough", "Verify", "Export to repo…", "Rebuild", "Delete"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    // Collapsed by default except the purpose.
    expect(screen.queryByText("src/file0.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Key files/ }));
    expect(screen.getByText("src/file0.ts").closest("a")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Read walkthrough" }));
    expect(slot.experimental_panelCalls).toEqual([{ method: "openTab", options: { tab: { id: ORIENTATION_TAB_ID, context: { kind: "thread" }, availability: "action" }, params: { orientationId: "ori_1" } } }]);

    fireEvent.click(screen.getByRole("button", { name: "Start orientation session" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "startOrientationSession")?.input).toEqual({ threadId: WORK, orientationId: "ori_1" }));
    await waitFor(() => expect(slot.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "thr_orient" })));

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "verifyOrientation")?.input).toEqual({ orientationId: "ori_1" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "startOrientation")?.input).toEqual({ threadId: WORK, depth: "walkthrough" }));
  });

  it("ready: Verify's toast says when no listing could be checked, rather than that none drifted", async () => {
    const said = vi.mocked(toast);
    said.mockClear();
    render({ current: orientation() }, { verifyOrientation: () => ({ checked: 0, drift: [] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    await waitFor(() => expect(said).toHaveBeenCalledWith("Could not reach this project's files to check the listings."));
    expect(said).not.toHaveBeenCalledWith(expect.stringContaining("none have drifted"));
    cleanup();
    said.mockClear();
    render({ current: orientation() });
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    await waitFor(() => expect(said).toHaveBeenCalledWith("Checked 4 listings; none have drifted."));
  });

  it("ready: Delete asks once more", async () => {
    const slot = render({ current: orientation() });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(slot.rpcCalls.find((c) => c.method === "deleteOrientation")).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "deleteOrientation")?.input).toEqual({ orientationId: "ori_1" }));
  });

  it("a summary-depth orientation has no walkthrough to read", async () => {
    render({ current: orientation({ depth: "summary", blocks: 0, listings: 0 }) });
    await screen.findByText("A calculator library.");
    expect(screen.queryByRole("button", { name: "Read walkthrough" })).toBeNull();
  });

  it("Export to repo… opens the export dialog", async () => {
    render({ current: orientation() });
    fireEvent.click(await screen.findByRole("button", { name: "Export to repo…" }));
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("ORIENTATION.md");
  });

  it("rebuilding a ready orientation shows the live state and keeps the summary", async () => {
    render({ current: orientation(), live: orientation({ id: "ori_live", status: "building", summary: null, blocks: 0, readyAt: null }) });
    await screen.findByText(/Building · 0 blocks/);
    expect(screen.getByText("A calculator library.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("Rebuild can upgrade a summary-only orientation to a walkthrough while the old guide stays visible", async () => {
    const summaryOnly = orientation({ depth: "summary", blocks: 0, listings: 0 });
    const slot = render({ current: summaryOnly });
    await screen.findByText("A calculator library.");
    const box = screen.getByRole("checkbox", { name: "Include a walkthrough" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "startOrientation")?.input).toEqual({ threadId: WORK, depth: "walkthrough" }));
    cleanup();
    render({ current: summaryOnly, live: orientation({ id: "ori_live", status: "building", depth: "walkthrough", summary: null, blocks: 0, readyAt: null }) });
    await screen.findByText(/Building · 0 blocks/);
    expect(screen.getByText("A calculator library.")).toBeTruthy();
  });

  it("a walkthrough's Rebuild defaults to a walkthrough, and the box can lower it", async () => {
    const slot = render({ current: orientation() });
    await screen.findByText("A calculator library.");
    expect((screen.getByRole("checkbox", { name: "Include a walkthrough" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include a walkthrough" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "startOrientation")?.input).toEqual({ threadId: WORK, depth: "summary" }));
  });

  it("failed: the error and Rebuild; with a ready one, the note sits above its summary", async () => {
    const failed = orientation({ id: "ori_f", status: "failed", summary: null, error: "The agent stopped early.", readyAt: null, blocks: 0, depth: "summary" });
    const slot = render({ last: failed });
    await screen.findByText(/The agent stopped early\./);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "startOrientation")?.input).toEqual({ threadId: WORK, depth: "summary" }));
    cleanup();
    render({ last: failed, current: orientation() });
    const note = await screen.findByText(/The agent stopped early\./);
    const purpose = screen.getByText("A calculator library.");
    expect(note.compareDocumentPosition(purpose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
