// @vitest-environment jsdom
/**
 * The Edit actions tab against a fake server: what it opens, the checks it shows while editing, the
 * file it saves, and a file that changed on disk meanwhile.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { EditorFile, SaveResult } from "../shared/views";
import { ActionsEditor } from "./editor";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => cleanup());

const FILE = `{
  "actions": [
    {
      "name": "Dev server",
      "command": "npm run dev",
      "description": "Vite"
    },
    {
      "name": "Run tests",
      "command": "npm test",
      "cwd": "web"
    }
  ]
}
`;

function render(options: { read?: () => Promise<EditorFile>; save?: (input: { text: string; expectedSha256: string | null }) => Promise<SaveResult> } = {}) {
  const reads: unknown[] = [];
  const saves: { threadId: string; text: string; expectedSha256: string | null }[] = [];
  const rpc: PluginRpcTestHandlers<RpcContract> = {
    list: async () => ({ state: "missing" }),
    run: async () => ({ terminalId: "term_1", outcome: "started" }),
    read: async (input) => {
      reads.push(input);
      return (options.read ?? (async () => ({ state: "ready", text: FILE, sha256: "sha-1", branch: "feature" }) as const))();
    },
    save: async (input) => {
      saves.push(input);
      return (options.save ?? (async () => ({ outcome: "saved", sha256: "sha-2" }) as const))(input);
    },
  };
  renderSlot<{ threadId: string }, RpcContract>({ component: ActionsEditor }, { threadId: "thr_1" }, { rpc });
  return { reads, saves };
}

const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const action = (name: string) => screen.getByRole("listitem", { name });
const field = (item: HTMLElement, label: RegExp) => within(item).getByLabelText(label) as HTMLInputElement;

describe("the Edit actions tab", () => {
  it("opens the workspace's file as a form, and says where a save lands", async () => {
    render();
    expect(await screen.findByRole("listitem", { name: "Dev server" })).toBeTruthy();
    expect(field(action("Run tests"), /Folder/).value).toBe("web");
    expect(field(action("Dev server"), /Description/).value).toBe("Vite");
    expect(screen.getByText(/in this thread's workspace, on feature/)).toBeTruthy();
    expect(screen.getByText(/commit it to share it with other branches/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("saves an edit as 2-space JSON, only over the file it opened", async () => {
    const { saves } = render();
    fireEvent.change(field(await screen.findByRole("listitem", { name: "Run tests" }), /Command/), { target: { value: "npm run test:ci" } });
    fireEvent.click(saveButton());
    await screen.findByText(/Saved in this worktree/);
    expect(saves).toEqual([{ threadId: "thr_1", text: FILE.replace("npm test", "npm run test:ci"), expectedSha256: "sha-1" }]);
    expect(saveButton().disabled).toBe(true);
  });

  it("shows the menu's check on the field, and blocks the save", async () => {
    render();
    fireEvent.change(field(await screen.findByRole("listitem", { name: "Run tests" }), /Command/), { target: { value: " " } });
    expect(within(action("Run tests")).getByText('"command" must not be empty')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(field(action("Run tests"), /Name/), { target: { value: "dev server" } });
    expect(await screen.findByText('Two actions are named "dev server" (actions[0] and actions[1])')).toBeTruthy();
    fireEvent.change(field(action("dev server"), /Name/), { target: { value: "Run tests" } });
    fireEvent.change(field(action("Run tests"), /Command/), { target: { value: "npm test" } });
    fireEvent.change(field(action("Run tests"), /Folder/), { target: { value: "../elsewhere" } });
    expect(within(action("Run tests")).getByText('"cwd" must stay inside the project (no ..)')).toBeTruthy();
  });

  it("adds, moves and deletes actions", async () => {
    const { saves } = render();
    await screen.findByRole("listitem", { name: "Dev server" });
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    const added = screen.getByRole("listitem", { name: "Action 3" });
    // A new action shows no errors until it is filled in; the save says what it waits for.
    expect(within(added).queryByText(/must not be empty/)).toBeNull();
    expect(screen.getByText("Fill in each new action's name and command to save.")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(field(added, /Name/), { target: { value: "Lint" } });
    fireEvent.change(field(action("Lint"), /Command/), { target: { value: "npm run lint" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Lint up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Dev server" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(JSON.parse(saves[0]!.text)).toEqual({
      actions: [
        { name: "Lint", command: "npm run lint" },
        { name: "Run tests", command: "npm test", cwd: "web" },
      ],
    });
  });

  it("creates the file when there is none, starting with one action to fill in", async () => {
    const { saves } = render({ read: async () => ({ state: "ready", text: null, sha256: null, branch: "main" }) });
    expect(await screen.findByText("This workspace has no actions file yet. Saving creates it.")).toBeTruthy();
    const first = screen.getByRole("listitem", { name: "Action 1" });
    fireEvent.change(field(first, /Name/), { target: { value: "Dev server" } });
    fireEvent.change(field(action("Dev server"), /Command/), { target: { value: "npm run dev" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ threadId: "thr_1", text: '{\n  "actions": [\n    {\n      "name": "Dev server",\n      "command": "npm run dev"\n    }\n  ]\n}\n', expectedSha256: null });
  });

  it("does not overwrite a file that changed on disk, and reloads it on request", async () => {
    let text = FILE;
    const { reads } = render({ read: async () => ({ state: "ready", text, sha256: "sha-1", branch: null }), save: async () => ({ outcome: "conflict" }) });
    fireEvent.change(field(await screen.findByRole("listitem", { name: "Run tests" }), /Command/), { target: { value: "npm run test:ci" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/changed on disk since you opened it, so it was not saved/)).toBeTruthy();
    text = FILE.replace("Vite", "Vite, on port 5173");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(field(screen.getByRole("listitem", { name: "Dev server" }), /Description/).value).toBe("Vite, on port 5173"));
    expect(field(action("Run tests"), /Command/).value).toBe("npm test");
    expect(reads).toHaveLength(2);
  });

  it("keeps JSON typed while a save is on its way, and leaves it to save", async () => {
    let finish: (result: SaveResult) => void = () => {};
    const { saves } = render({ save: () => new Promise<SaveResult>((resolve) => (finish = resolve)) });
    await screen.findByRole("listitem", { name: "Dev server" });
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const textarea = screen.getByLabelText(".bb/actions.json") as HTMLTextAreaElement;
    const first = FILE.replace("npm test", "npm run test:ci");
    fireEvent.change(textarea, { target: { value: first } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves).toHaveLength(1));
    // Typed after Save, before the machine answered.
    const later = first.replace("Vite", "Vite, on port 5173");
    fireEvent.change(textarea, { target: { value: later } });
    await act(async () => finish({ outcome: "saved", sha256: "sha-2" }));
    expect(await screen.findByText(/Saved in this worktree/)).toBeTruthy();
    expect(textarea.value).toBe(later);
    expect(saveButton().disabled).toBe(false);
    // The next save sends the later edit, over the file the first save wrote.
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toEqual({ threadId: "thr_1", text: later, expectedSha256: "sha-2" });
  });

  it("keeps form edits made while a save is on its way", async () => {
    let finish: (result: SaveResult) => void = () => {};
    render({ save: () => new Promise<SaveResult>((resolve) => (finish = resolve)) });
    fireEvent.change(field(await screen.findByRole("listitem", { name: "Run tests" }), /Command/), { target: { value: "npm run test:ci" } });
    fireEvent.click(saveButton());
    fireEvent.change(field(action("Dev server"), /Description/), { target: { value: "Vite, on port 5173" } });
    await act(async () => finish({ outcome: "saved", sha256: "sha-2" }));
    expect(field(action("Dev server"), /Description/).value).toBe("Vite, on port 5173");
    expect(field(action("Run tests"), /Command/).value).toBe("npm run test:ci");
    expect(saveButton().disabled).toBe(false);
  });

  it("says why a save failed", async () => {
    render({
      save: async () => {
        throw new Error("MacBook Air is offline, so its workspace cannot be read.");
      },
    });
    fireEvent.change(field(await screen.findByRole("listitem", { name: "Run tests" }), /Command/), { target: { value: "npm run test:ci" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("MacBook Air is offline, so its workspace cannot be read.")).toBeTruthy();
  });

  it("opens a file with a mistake as JSON, with the menu's message and where it is", async () => {
    const { saves } = render({ read: async () => ({ state: "ready", text: '{\n  "actions": [\n    { "name": "Lint" }\n  ]\n}\n', sha256: "sha-1", branch: null }) });
    const textarea = (await screen.findByLabelText(".bb/actions.json")) as HTMLTextAreaElement;
    expect(screen.getByText('Missing "command"')).toBeTruthy();
    expect(screen.getByText(".bb/actions.json, line 3, column 5 (actions[0])")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Form" }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    const fixed = '{\n  "actions": [\n    { "name": "Lint", "command": "npm run lint" }\n  ]\n}\n';
    fireEvent.change(textarea, { target: { value: fixed } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves).toEqual([{ threadId: "thr_1", text: fixed, expectedSha256: "sha-1" }]));
    fireEvent.click(screen.getByRole("button", { name: "Form" }));
    expect(field(screen.getByRole("listitem", { name: "Lint" }), /Command/).value).toBe("npm run lint");
  });

  it("switches between the form and the same file as JSON", async () => {
    render();
    await screen.findByRole("listitem", { name: "Dev server" });
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect((screen.getByLabelText(".bb/actions.json") as HTMLTextAreaElement).value).toBe(FILE);
    expect(saveButton().disabled).toBe(true);
  });

  it("says when the workspace cannot be read, and tries again", async () => {
    let answer: EditorFile = { state: "unavailable", message: "This thread's workspace is gone." };
    render({ read: async () => answer });
    expect(await screen.findByText("This thread's workspace is gone.")).toBeTruthy();
    answer = { state: "ready", text: FILE, sha256: "sha-1", branch: null };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("listitem", { name: "Dev server" })).toBeTruthy();
  });
});
