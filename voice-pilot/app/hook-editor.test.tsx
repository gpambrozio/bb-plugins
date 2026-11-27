// @vitest-environment jsdom
/**
 * Voice Pilot's hook editor, as bb draws it in its file panel: it loads the machine's hook script, saves it back
 * with the hash it was loaded as, warns when the file changed on disk (Reload, or Save anyway), and says so
 * when the machine is offline or the save fails there.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { rpcContract } from "../server";
import type { HookFileRead, HookWriteResult } from "../shared/hooks";
import { CONFLICT_TEXT, GONE_TEXT, HookEditor, savedText } from "./hook-editor";
import { rememberEditorMachine } from "./hook-file";

type Rpc = PluginRpcTestHandlers<typeof rpcContract>;

const PATH = "/Users/someone/.config/voice-pilot/hook.sh";
const SHA = "a".repeat(64);
const SOURCE = { kind: "host" as const, threadId: null, environmentId: null, projectId: null, experimental_hostId: "host_studio" };

function machine(reads: Array<HookFileRead | Error>, writes: Array<HookWriteResult | Error> = []) {
  const sent: { read: string[]; write: Array<{ hostId: string; name: string; content: string; expectedSha256: string }> } = { read: [], write: [] };
  const rpc = {
    "hooks.read": async ({ hostId }: { hostId: string }) => {
      sent.read.push(hostId);
      const next = reads.length > 1 ? reads.shift() : reads[0];
      if (next instanceof Error) throw next;
      return next as HookFileRead;
    },
    "hooks.write": async (input: { hostId: string; name: string; content: string; expectedSha256: string }) => {
      sent.write.push(input);
      const next = writes.shift();
      if (next === undefined) throw new Error("unexpected write");
      if (next instanceof Error) throw next;
      return next;
    },
  } as Partial<Rpc> as Rpc;
  return { rpc, sent };
}

const text = (content: string, overrides: Partial<Extract<HookFileRead, { kind: "text" }>> = {}): HookFileRead => ({
  kind: "text",
  name: "hook.sh",
  path: PATH,
  content,
  sha256: SHA,
  executable: true,
  ...overrides,
});

function open(rpc: Rpc, source: typeof SOURCE | Omit<typeof SOURCE, "experimental_hostId"> = SOURCE) {
  rememberEditorMachine({ kind: "host", hostId: "host_studio", path: PATH }, "Studio");
  return renderSlot({ component: HookEditor }, { path: PATH, source, Original: () => null }, { rpc });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the hook editor", () => {
  it("loads the script from its machine and saves the edit with the hash it was loaded as", async () => {
    const { rpc, sent } = machine([text("#!/bin/sh\necho old\n")], [{ outcome: "written", sha256: "c".repeat(64), executable: true }]);
    open(rpc);
    const box = (await screen.findByRole("textbox", { name: "Hook script" })) as HTMLTextAreaElement;
    expect(box.value).toBe("#!/bin/sh\necho old\n");
    expect(screen.getByText(/~\/\.config\/voice-pilot\/hook\.sh on Studio/u)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "#!/bin/sh\necho new\n" } });
    expect(screen.getByText(/unsaved/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(savedText("Studio", true));
    expect(sent.read).toEqual(["host_studio"]);
    expect(sent.write).toEqual([{ hostId: "host_studio", name: "hook.sh", content: "#!/bin/sh\necho new\n", expectedSha256: SHA }]);
    // The next save goes with the hash it was saved as.
    expect(screen.queryByText(/unsaved/u)).toBeNull();
  });

  it("says when the saved file is not executable, and so does not run", async () => {
    const { rpc } = machine([text("a", { executable: false })], [{ outcome: "written", sha256: "c".repeat(64), executable: false }]);
    open(rpc);
    expect(await screen.findByText(/This file is not executable, so it does not run/u)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(savedText("Studio", false));
  });

  it("warns when the file changed on disk since it was loaded, and Save anyway replaces it", async () => {
    const now = "d".repeat(64);
    const { rpc, sent } = machine([text("loaded")], [{ outcome: "conflict", currentSha256: now }, { outcome: "written", sha256: "e".repeat(64), executable: true }]);
    open(rpc);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(CONFLICT_TEXT);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    await screen.findByText(savedText("Studio", true));
    expect(sent.write.map((write) => write.expectedSha256)).toEqual([SHA, now]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Reload, not Save anyway, when the file is gone, and Reload shows what is there now", async () => {
    const { rpc, sent } = machine([text("loaded"), { kind: "missing" }], [{ outcome: "conflict", currentSha256: null }]);
    open(rpc);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(GONE_TEXT);
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await screen.findByText("Studio has no hook script any more.");
    expect(sent.read).toHaveLength(2);
  });

  it("says why a save failed on the machine, keeping the edit", async () => {
    const { rpc } = machine([text("a")], [{ outcome: "failed", reason: "EACCES: permission denied" }]);
    open(rpc);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Could not save it on Studio: EACCES: permission denied");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("b");
  });

  it("says the machine is offline when it cannot load or save, keeping the edit", async () => {
    const offline = new Error("Could not reach Studio: it may be offline, or bb's host daemon there is not running.");
    const loadOffline = machine([offline]);
    open(loadOffline.rpc);
    await screen.findByText(offline.message);
    cleanup();
    const saveOffline = machine([text("a")], [offline]);
    open(saveOffline.rpc);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(offline.message);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("b");
  });

  it("finds the machine it remembered when bb does not pass one", async () => {
    const { rpc, sent } = machine([text("a")]);
    const { experimental_hostId: _unused, ...withoutHost } = SOURCE;
    open(rpc, withoutHost);
    await screen.findByRole("textbox");
    await waitFor(() => expect(sent.read).toEqual(["host_studio"]));
  });
});
