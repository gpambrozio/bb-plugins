// @vitest-environment jsdom
/** The walkthrough tab and the export dialog. */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract } from "../shared/contract";
import type { Orientation, OrientationBlock } from "../shared/orientation";
import { ExportDialog } from "./export-dialog";
import { OrientationTab } from "./orientation-tab";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(cleanup);

const ori = {
  id: "ori_1", status: "ready", depth: "walkthrough", title: "calc", summary: null, blocks: 4, listings: 2,
  createdAt: 1, updatedAt: 2, readyAt: 2, error: null, headSha: "abc",
  workspace: { threadId: "thr_work", environmentId: "env_1", rootPath: "/work/calc" },
} as Orientation;

const blocks: OrientationBlock[] = [
  { kind: "chapter", ordinal: 0, title: "Lexing" },
  { kind: "note", ordinal: 1, markdown: "See Listing 1 and Listing 2." },
  { kind: "listing", ordinal: 2, number: 1, caption: "The lexer", path: "src/lex.ts", startLine: 10, endLine: 40, text: "const a = 1;", ref: "abcdef0123", check: { state: "moved", startLine: 52, endLine: 84, checkedAt: 5 } },
  { kind: "listing", ordinal: 3, number: 2, caption: "The parser", path: "src/parse.ts", startLine: 1, endLine: 5, text: "let b;", ref: "1234567890", check: { state: "changed", startLine: null, endLine: null, checkedAt: 5 } },
];

function renderTab(params: unknown, extra: Record<string, (input: never) => unknown> = {}) {
  return renderSlot({ component: OrientationTab }, { threadId: "thr_work", environment: null, params }, {
    rpc: { orientationDocument: () => ({ orientation: ori, blocks }), verifyOrientation: () => ({ checked: 2, drift: [] }), ...extra } as never,
    experimental_rpcContract: rpcContract,
  });
}

describe("the walkthrough tab", () => {
  it("shows a moved listing's badge and a link at the moved range", async () => {
    renderTab({ orientationId: "ori_1" });
    await screen.findByText("Listing 1: The lexer");
    expect(screen.getByText("moved to 52–84")).toBeTruthy();
    expect(screen.getByText("changed since 1234567")).toBeTruthy();
    expect(screen.getByText("const a = 1;")).toBeTruthy();
    const link = screen.getAllByRole("link").find((a) => a.textContent?.includes("src/lex.ts"));
    expect(link).toBeTruthy();
  });

  it("scrolls its own container from Contents, never scrollIntoView", async () => {
    const spy = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = spy;
    renderTab({ orientationId: "ori_1" });
    await screen.findByText("Listing 1: The lexer");
    const root = screen.getByTestId("walkthrough-scroll");
    const heading = document.getElementById("chapter-0") as HTMLElement;
    root.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    heading.getBoundingClientRect = () => ({ top: 300, bottom: 320, height: 20, left: 0, right: 0, width: 0, x: 0, y: 300, toJSON() {} }) as DOMRect;
    fireEvent.click(screen.getByRole("button", { name: "Lexing" }));
    expect(root.scrollTop).toBe(300);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an invalid param says the walkthrough is gone", () => {
    renderTab({ nope: 1 });
    expect(screen.getByText("This walkthrough is no longer available.")).toBeTruthy();
  });

  it("Verify calls verifyOrientation", async () => {
    const slot = renderTab({ orientationId: "ori_1" });
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    await waitFor(() => expect(slot.rpcCalls.find((c) => c.method === "verifyOrientation")?.input).toEqual({ orientationId: "ori_1" }));
  });
});

describe("the export dialog", () => {
  it("asks before replacing, then sends the hash with replace", async () => {
    const answers: unknown[] = [{ exists: true, sha256: "h1" }, { written: "ORIENTATION.md" }];
    const slot = renderSlot({ component: ExportDialog }, { orientationId: "ori_1", onDone: vi.fn() }, {
      rpc: { exportOrientation: () => answers.shift() } as never,
      experimental_rpcContract: rpcContract,
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText("ORIENTATION.md already exists. Replace it?");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await screen.findByText("Wrote ORIENTATION.md.");
    const calls = slot.rpcCalls.filter((c) => c.method === "exportOrientation").map((c) => c.input);
    expect(calls[0]).toEqual({ orientationId: "ori_1", path: "ORIENTATION.md", replace: false });
    expect(calls[1]).toEqual({ orientationId: "ori_1", path: "ORIENTATION.md", replace: true, expectedSha256: "h1" });
  });

  it("shows a refusal and stays open", async () => {
    renderSlot({ component: ExportDialog }, { orientationId: "ori_1", onDone: vi.fn() }, {
      rpc: { exportOrientation: () => { throw new Error("changed while you were deciding"); } } as never,
      experimental_rpcContract: rpcContract,
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText(/changed while you were deciding/);
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });
});
