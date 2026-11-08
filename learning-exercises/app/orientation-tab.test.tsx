// @vitest-environment jsdom
/** The walkthrough tab and the export dialog. */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract } from "../shared/contract";
import type { Orientation, OrientationBlock } from "../shared/orientation";
import { ExportDialog } from "./export-dialog";
import { OrientationTab, verifyMessage } from "./orientation-tab";

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

function renderTab(params: unknown, extra: Record<string, (input: never) => unknown> = {}, options: { tabVisible?: boolean } = {}) {
  return renderSlot({ component: OrientationTab }, { threadId: "thr_work", environment: null, params }, {
    rpc: { orientationDocument: () => ({ orientation: ori, blocks }), verifyOrientation: () => ({ checked: 2, drift: [] }), ...extra } as never,
    experimental_rpcContract: rpcContract,
    ...options,
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
    const heading = root.querySelector<HTMLElement>('[data-scroll-id="chapter-0"]') as HTMLElement;
    root.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    heading.getBoundingClientRect = () => ({ top: 300, bottom: 320, height: 20, left: 0, right: 0, width: 0, x: 0, y: 300, toJSON() {} }) as DOMRect;
    fireEvent.click(screen.getByRole("button", { name: "Lexing" }));
    expect(root.scrollTop).toBe(300);
    expect(spy).not.toHaveBeenCalled();
  });

  it("two viewers at once: each scrolls its own container with its own elements", async () => {
    renderTab({ orientationId: "ori_1" });
    renderTab({ orientationId: "ori_1" });
    await waitFor(() => expect(screen.getAllByTestId("walkthrough-scroll")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByText("Listing 1: The lexer")).toHaveLength(2));
    const [first, second] = screen.getAllByTestId("walkthrough-scroll");
    const rect = (top: number, height: number) => () => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
    for (const root of [first, second]) root.getBoundingClientRect = rect(0, 500);
    const target = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-scroll-id="${id}"]`) as HTMLElement;
    target(first, "chapter-0").getBoundingClientRect = rect(100, 20);
    target(second, "chapter-0").getBoundingClientRect = rect(300, 20);
    target(first, "listing-2").getBoundingClientRect = rect(50, 20);
    target(second, "listing-2").getBoundingClientRect = rect(400, 20);
    fireEvent.click(within(second).getByRole("button", { name: "Lexing" }));
    expect(second.scrollTop).toBe(300);
    expect(first.scrollTop).toBe(0);
    fireEvent.click(within(second).getByRole("button", { name: "2" }));
    expect(second.scrollTop).toBe(700);
    expect(first.scrollTop).toBe(0);
  });

  it("reads the walkthrough only while the tab shows: each read may check the listings", async () => {
    const hidden = renderTab({ orientationId: "ori_1" }, {}, { tabVisible: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hidden.rpcCalls.filter((c) => c.method === "orientationDocument")).toEqual([]);
    cleanup();
    const shown = renderTab({ orientationId: "ori_1" });
    await screen.findByText("Listing 1: The lexer");
    expect(shown.rpcCalls.filter((c) => c.method === "orientationDocument")).toHaveLength(1);
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

describe("Verify's toast", () => {
  it("says the files could not be reached when nothing was checked, and the count otherwise", async () => {
    const said = vi.mocked(toast);
    said.mockClear();
    renderTab({ orientationId: "ori_1" }, { verifyOrientation: () => ({ checked: 0, drift: [] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    await waitFor(() => expect(said).toHaveBeenCalledWith("Could not reach this project's files to check the listings."));
    cleanup();
    said.mockClear();
    renderTab({ orientationId: "ori_1" }, { verifyOrientation: () => ({ checked: 2, drift: ["Listing 2 (`src/parse.ts:1-5`) missing"] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    await waitFor(() => expect(said).toHaveBeenCalledWith("Checked 2 listings; 1 drifted: Listing 2 (`src/parse.ts:1-5`) missing"));
  });

  it("says a summary-only orientation has no listings to check", () => {
    expect(verifyMessage({ checked: 0, drift: [] }, 0)).toBe("This orientation has no listings to check.");
    expect(verifyMessage({ checked: 0, drift: [] }, 3)).toBe("Could not reach this project's files to check the listings.");
    expect(verifyMessage({ checked: 1, drift: [] }, 1)).toBe("Checked 1 listing; none have drifted.");
  });
});

/** A project tree for the picker: folders and files by folder ("" is the root). */
const TREE: Record<string, { folders: string[]; files: string[] }> = {
  "": { folders: ["docs", "src"], files: ["ORIENTATION.md", "README.md"] },
  docs: { folders: ["api"], files: ["guide.md"] },
  "docs/api": { folders: [], files: [] },
  src: { folders: [], files: ["a.ts"] },
};

function renderExport(rpc: Record<string, (input: never) => unknown> = {}) {
  return renderSlot({ component: ExportDialog }, { orientationId: "ori_1", onDone: vi.fn() }, {
    rpc: {
      browseOrientationFolder: (input: { dir: string }) => {
        const folder = TREE[input.dir];
        if (folder === undefined) throw new Error(`${input.dir} links outside its place in the project; choose another folder.`);
        return { dir: input.dir, ...folder };
      },
      exportOrientation: (input: { path: string }) => ({ written: input.path }),
      ...rpc,
    } as never,
    experimental_rpcContract: rpcContract,
  });
}

const entries = () => within(screen.getByRole("list", { name: "Folders and files" }));
const nameBox = () => screen.getByRole("textbox", { name: "File name" }) as HTMLInputElement;
const exportCalls = (slot: ReturnType<typeof renderExport>) => slot.rpcCalls.filter((c) => c.method === "exportOrientation").map((c) => c.input);

describe("the export dialog", () => {
  it("starts at the project root with ORIENTATION.md, listing its folders and files", async () => {
    const slot = renderExport();
    await screen.findByRole("button", { name: "README.md" });
    expect(screen.getByTestId("export-folder").textContent).toBe("Project root");
    expect((screen.getByRole("button", { name: "Up one folder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(entries().getAllByRole("button").map((b) => b.textContent)).toEqual(["docs", "src", "ORIENTATION.md", "README.md"]);
    expect(nameBox().value).toBe("ORIENTATION.md");
    expect(entries().getByRole("button", { name: "ORIENTATION.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Exports to ORIENTATION.md")).toBeTruthy();
    expect(slot.rpcCalls.find((c) => c.method === "browseOrientationFolder")?.input).toEqual({ orientationId: "ori_1", dir: "" });
  });

  it("opens folders and goes back up, exporting into the folder shown", async () => {
    const slot = renderExport();
    fireEvent.click(await screen.findByRole("button", { name: "docs" }));
    await screen.findByRole("button", { name: "guide.md" });
    expect(screen.getByTestId("export-folder").textContent).toBe("docs/");
    fireEvent.click(screen.getByRole("button", { name: "api" }));
    await screen.findByText("This folder is empty.");
    expect(screen.getByText("Exports to docs/api/ORIENTATION.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
    await screen.findByRole("button", { name: "guide.md" });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText("Wrote docs/ORIENTATION.md.");
    expect(exportCalls(slot)).toEqual([{ orientationId: "ori_1", path: "docs/ORIENTATION.md", replace: false }]);
  });

  it("picking an existing file takes its name and leads to the overwrite prompt, which sends its hash", async () => {
    const answers: unknown[] = [{ exists: true, sha256: "h1" }, { written: "docs/guide.md" }];
    const slot = renderExport({ exportOrientation: () => answers.shift() });
    fireEvent.click(await screen.findByRole("button", { name: "docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "guide.md" }));
    expect(nameBox().value).toBe("guide.md");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText("docs/guide.md already exists. Replace it?");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await screen.findByText("Wrote docs/guide.md.");
    expect(exportCalls(slot)).toEqual([
      { orientationId: "ori_1", path: "docs/guide.md", replace: false },
      { orientationId: "ori_1", path: "docs/guide.md", replace: true, expectedSha256: "h1" },
    ]);
  });

  it("takes a file name only: a folder in it, or . and .., disables Export", async () => {
    renderExport();
    await screen.findByRole("button", { name: "README.md" });
    const exportButton = screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;
    for (const name of ["../x.md", "docs/x.md", "..", "  "]) {
      fireEvent.change(nameBox(), { target: { value: name } });
      expect(exportButton.disabled).toBe(true);
    }
    fireEvent.change(nameBox(), { target: { value: "NOTES.md" } });
    expect(exportButton.disabled).toBe(false);
    expect(screen.getByText("Exports to NOTES.md")).toBeTruthy();
  });

  it("shows a folder's refusal in the list, and Up still leaves it", async () => {
    renderExport({ browseOrientationFolder: (input: { dir: string }) => {
      if (input.dir === "src") throw new Error("src links outside its place in the project; choose another folder.");
      return { dir: input.dir, ...TREE[input.dir]! };
    } });
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    await screen.findByText(/src links outside its place in the project/);
    fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
    await screen.findByRole("button", { name: "README.md" });
  });

  it("shows an export refusal and stays open", async () => {
    renderExport({ exportOrientation: () => { throw new Error("changed while you were deciding"); } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText(/changed while you were deciding/);
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });
});
