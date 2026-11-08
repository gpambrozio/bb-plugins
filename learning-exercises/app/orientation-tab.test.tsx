// @vitest-environment jsdom
/** The walkthrough tab and the export dialog. */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract } from "../shared/contract";
import type { Orientation, OrientationBlock } from "../shared/orientation";
import { ExportDialog } from "./export-dialog";
import { OrientationTab, chapterInView, verifyMessage } from "./orientation-tab";

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
  { kind: "chapter", ordinal: 4, title: "Evaluating" },
  { kind: "note", ordinal: 5, markdown: "The evaluator walks the tree." },
  { kind: "chapter", ordinal: 6, title: "Printing" },
];

const rect = (top: number, height: number) => () => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
const target = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-scroll-id="${id}"]`) as HTMLElement;
/**
 * Lays a scroller out: its box at 0 with 500 px showing of 2000, and each chapter heading at its offset in
 * the content, so a heading's box moves as the scroller's `scrollTop` does.
 */
function layout(root: HTMLElement, offsets: Record<number, number>) {
  root.getBoundingClientRect = rect(0, 500);
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: 2_000 });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 500 });
  for (const [ordinal, offset] of Object.entries(offsets)) target(root, `chapter-${ordinal}`).getBoundingClientRect = () => rect(offset - root.scrollTop, 20)();
}
/** The user scrolling `root` to `scrollTop`. */
function userScroll(root: HTMLElement, scrollTop: number) {
  fireEvent.wheel(root);
  root.scrollTop = scrollTop;
  fireEvent.scroll(root);
}
const sectionBox = (scope: { getByRole: typeof screen.getByRole } = screen) => scope.getByRole("combobox", { name: "Section" }) as HTMLSelectElement;

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

  it("pins a Section selector of the chapters above its own scroller, in place of a Contents list", async () => {
    renderTab({ orientationId: "ori_1" });
    await screen.findByText("Listing 1: The lexer");
    const box = sectionBox();
    expect(Array.from(box.options, (option) => option.textContent)).toEqual(["Lexing", "Evaluating", "Printing"]);
    expect(box.value).toBe("0");
    expect(screen.getByTestId("walkthrough-scroll").contains(box)).toBe(false);
    expect(screen.queryByText("Contents")).toBeNull();
  });

  it("choosing a section scrolls its own container there, never scrollIntoView", async () => {
    const spy = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = spy;
    renderTab({ orientationId: "ori_1" });
    await screen.findByText("Listing 1: The lexer");
    const root = screen.getByTestId("walkthrough-scroll");
    layout(root, { 0: 0, 4: 300, 6: 900 });
    fireEvent.change(sectionBox(), { target: { value: "4" } });
    expect(root.scrollTop).toBe(300);
    expect(sectionBox().value).toBe("4");
    expect(spy).not.toHaveBeenCalled();
  });

  it("follows the chapter in view as the user scrolls", async () => {
    renderTab({ orientationId: "ori_1" });
    await screen.findByText("Listing 1: The lexer");
    const root = screen.getByTestId("walkthrough-scroll");
    layout(root, { 0: 0, 4: 400, 6: 1_000 });
    userScroll(root, 400);
    await waitFor(() => expect(sectionBox().value).toBe("4"));
    userScroll(root, 995);
    await waitFor(() => expect(sectionBox().value).toBe("6"));
    userScroll(root, 0);
    await waitFor(() => expect(sectionBox().value).toBe("0"));
  });

  it("a chapter chosen near the end stays chosen until the user scrolls themselves", async () => {
    renderTab({ orientationId: "ori_1" });
    await screen.findByText("Listing 1: The lexer");
    const root = screen.getByTestId("walkthrough-scroll");
    // Evaluating reaches the top only at the very bottom, with Printing in view below it.
    layout(root, { 0: 0, 4: 1_500, 6: 1_600 });
    fireEvent.change(sectionBox(), { target: { value: "4" } });
    expect(root.scrollTop).toBe(1_500);
    fireEvent.scroll(root);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sectionBox().value).toBe("4");
    userScroll(root, 1_500);
    await waitFor(() => expect(sectionBox().value).toBe("6"));
  });

  it("two viewers at once: each scrolls and follows its own container with its own elements", async () => {
    renderTab({ orientationId: "ori_1" });
    renderTab({ orientationId: "ori_1" });
    await waitFor(() => expect(screen.getAllByTestId("walkthrough-scroll")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByText("Listing 1: The lexer")).toHaveLength(2));
    const [first, second] = screen.getAllByTestId("walkthrough-scroll");
    const [firstBox, secondBox] = screen.getAllByRole("combobox", { name: "Section" }) as HTMLSelectElement[];
    layout(first!, { 0: 100, 4: 600, 6: 900 });
    layout(second!, { 0: 0, 4: 300, 6: 900 });
    target(first!, "listing-2").getBoundingClientRect = rect(50, 20);
    target(second!, "listing-2").getBoundingClientRect = () => rect(700 - second!.scrollTop, 20)();
    fireEvent.change(secondBox!, { target: { value: "4" } });
    expect(second!.scrollTop).toBe(300);
    expect(first!.scrollTop).toBe(0);
    expect(firstBox!.value).toBe("0");
    fireEvent.click(within(second!).getByRole("button", { name: "2" }));
    expect(second!.scrollTop).toBe(700);
    expect(first!.scrollTop).toBe(0);
    userScroll(second!, 900);
    await waitFor(() => expect(secondBox!.value).toBe("6"));
    expect(firstBox!.value).toBe("0");
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

describe("chapterInView", () => {
  const view = { top: 100, bottom: 600 };
  const chapters = [{ ordinal: 0, top: 100 }, { ordinal: 4, top: 300 }, { ordinal: 6, top: 500 }];

  it("is the last chapter whose heading reached the top, the first before any has", () => {
    expect(chapterInView(chapters, view, false)).toBe(0);
    expect(chapterInView([{ ordinal: 0, top: 150 }, { ordinal: 4, top: 300 }], view, false)).toBe(0);
    expect(chapterInView([{ ordinal: 0, top: -300 }, { ordinal: 4, top: 105 }, { ordinal: 6, top: 500 }], view, false)).toBe(4);
    expect(chapterInView([{ ordinal: 0, top: -300 }, { ordinal: 4, top: 120 }], view, false)).toBe(0);
  });

  it("at the bottom, the last heading in view", () => {
    expect(chapterInView(chapters, view, true)).toBe(6);
    expect(chapterInView([{ ordinal: 0, top: -300 }, { ordinal: 4, top: 300 }, { ordinal: 6, top: 650 }], view, true)).toBe(4);
  });

  it("is null without chapters", () => {
    expect(chapterInView([], view, false)).toBeNull();
  });
});

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
