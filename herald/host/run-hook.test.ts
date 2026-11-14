import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import hostEntry from "../host";
import { runHook } from "./run-hook";

const posix = process.platform !== "win32";
let dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "herald-hook-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe.runIf(posix)("runHook", () => {
  it("runs the command through the shell, with HERALD_HOOK set, and waits for it", async () => {
    const dir = scratch();
    const out = join(dir, "out");
    const run = await runHook("before", `printf '%s' "$HERALD_HOOK" > '${out}'`);
    expect(run).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stderr: "" });
    expect(readFileSync(out, "utf8")).toBe("before");
  });

  it("reports a failure with the end of its error output", async () => {
    const run = await runHook("after", "echo 'no music app' >&2; exit 3");
    expect(run).toMatchObject({ exitCode: 3, timedOut: false, stderr: "no music app\n" });
  });

  it("stops a command that runs out of time, with what it started", async () => {
    const dir = scratch();
    const marker = join(dir, "child-still-running");
    const started = Date.now();
    // The child would write the marker after a second, unless the whole group is killed.
    const run = await runHook("before", `(sleep 1; touch '${marker}') & sleep 30`, { timeoutMs: 200 });
    expect(run).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(() => readFileSync(marker)).toThrow();
  });

  it("does not wait for a background process left holding its output", async () => {
    const started = Date.now();
    const run = await runHook("after", "sleep 5 >&2 &");
    expect(run.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("is reachable through the host entry", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    try {
      await expect(harness.experimental_call("runHook", { kind: "after", command: "exit 0" })).resolves.toMatchObject({ exitCode: 0 });
      await expect(harness.experimental_call("runHook", { kind: "after", command: "" })).rejects.toThrow();
    } finally {
      await harness.experimental_dispose();
    }
  });
});
