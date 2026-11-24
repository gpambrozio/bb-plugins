import { describe, expect, it, vi } from "vitest";

import { reportBbCommand, runAction, type ActionDeps } from "./actions";

function deps(overrides: Partial<ActionDeps> = {}) {
  const notify = { success: vi.fn(), error: vi.fn(), message: vi.fn() };
  const value: ActionDeps = {
    navigate: { toThread: vi.fn(), toProject: vi.fn(), toCompose: vi.fn(), openUrl: vi.fn(() => true) },
    history: { back: vi.fn(), forward: vi.fn() },
    reload: vi.fn(),
    runBbCommand: vi.fn(async () => ({ outcome: "finished" as const, exitCode: 0, output: "done" })),
    notify: notify as unknown as ActionDeps["notify"],
    ...overrides,
  };
  return { deps: value, notify };
}

describe("runAction", () => {
  it("goes back, forward and reloads", () => {
    const { deps: d } = deps();
    runAction({ kind: "back" }, d);
    runAction({ kind: "forward" }, d);
    runAction({ kind: "reload" }, d);
    expect(d.history.back).toHaveBeenCalledOnce();
    expect(d.history.forward).toHaveBeenCalledOnce();
    expect(d.reload).toHaveBeenCalledOnce();
  });

  it("opens a new thread with bb's own project choice, or the one picked", () => {
    const { deps: d } = deps();
    runAction({ kind: "newThread", projectId: null }, d);
    runAction({ kind: "newThread", projectId: "p1" }, d);
    expect(d.navigate.toCompose).toHaveBeenNthCalledWith(1, undefined);
    expect(d.navigate.toCompose).toHaveBeenNthCalledWith(2, { projectId: "p1" });
  });

  it("says so when bb will not open an address", () => {
    const { deps: d, notify } = deps({ navigate: { toThread: vi.fn(), toProject: vi.fn(), toCompose: vi.fn(), openUrl: vi.fn(() => false) } });
    runAction({ kind: "openUrl", url: "javascript:alert(1)" }, d);
    expect(notify.error).toHaveBeenCalledWith("bb would not open that address", { description: "javascript:alert(1)" });
  });

  it("runs a bb command and reports how it went", async () => {
    const { deps: d, notify } = deps();
    runAction({ kind: "bbCommand", args: ["herald", "say", "hi"] }, d);
    expect(notify.message).toHaveBeenCalledWith("Running bb herald say hi…", { id: expect.any(String) });
    const { id } = notify.message.mock.calls[0]?.[1] as { id: string };
    // The result takes the running notice's place.
    await vi.waitFor(() => expect(notify.success).toHaveBeenCalledWith("bb herald say hi", { id, description: "done" }));
  });

  it("reports a bb command that could not start", async () => {
    const { deps: d, notify } = deps({ runBbCommand: vi.fn(async () => Promise.reject(new Error("no host"))) });
    runAction({ kind: "bbCommand", args: ["x"] }, d);
    await vi.waitFor(() => expect(notify.error).toHaveBeenCalledWith("Could not run bb x", { id: expect.any(String), description: "no host" }));
  });
});

describe("reportBbCommand", () => {
  it("names a failure's exit status and a timeout", () => {
    const { notify } = deps();
    reportBbCommand(notify as never, ["x"], { outcome: "finished", exitCode: 3, output: "bad" });
    reportBbCommand(notify as never, ["x"], { outcome: "timed-out", output: "" });
    reportBbCommand(notify as never, ["x"], { outcome: "unavailable", reason: "no cli" });
    expect(notify.error.mock.calls).toEqual([
      ["bb x failed (exit status 3)", { id: undefined, description: "bad" }],
      ["bb x was still running after a minute, so it was stopped", { id: undefined, description: undefined }],
      ["Could not run bb x", { id: undefined, description: "no cli" }],
    ]);
  });
});
