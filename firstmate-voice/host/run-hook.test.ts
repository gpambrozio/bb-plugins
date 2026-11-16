import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import hostEntry from "../host";
import { killRunningHooks, runHook } from "./run-hook";

const posix = process.platform !== "win32";
let dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fmv-hook-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe.runIf(posix)("running a voice hook on its machine", () => {
  it("runs the command through the shell from the home folder, with the moment and the reason set", async () => {
    const out = join(scratch(), "out");
    const run = await runHook("listening-stopped", "ended by the captain", `printf '%s|%s|%s' "$FIRSTMATE_VOICE_HOOK" "$FIRSTMATE_VOICE_REASON" "$PWD" > '${out}'`, {
      env: { ...process.env, HOME: process.env.HOME },
    });
    expect(run).toMatchObject({ exitCode: 0, signal: null, timedOut: false, failedToStart: false });
    const [event, reason, cwd] = readFileSync(out, "utf8").split("|");
    expect([event, reason]).toEqual(["listening-stopped", "ended by the captain"]);
    expect(cwd).toBe((await import("node:os")).homedir());
  });

  it("sets no reason on a moment that has none, even one left in the environment", async () => {
    const out = join(scratch(), "out");
    await runHook("speaking-started", null, `printf '%s' "\${FIRSTMATE_VOICE_REASON-unset}" > '${out}'`, {
      env: { ...process.env, FIRSTMATE_VOICE_REASON: "stale" },
    });
    expect(readFileSync(out, "utf8")).toBe("unset");
  });

  it("reports the exit status, and never the output", async () => {
    const run = await runHook("talking-started", null, "echo 'a secret' ; echo 'another' >&2; exit 3");
    expect(run).toEqual({ exitCode: 3, signal: null, timedOut: false, failedToStart: false, durationMs: expect.any(Number) });
  });

  it("stops a command that runs out of time, with what it started", async () => {
    const marker = join(scratch(), "child-still-running");
    const started = Date.now();
    const run = await runHook("speaking-started", null, `(sleep 1; touch '${marker}') & sleep 30`, { timeoutMs: 200 });
    expect(run).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(() => readFileSync(marker)).toThrow();
  });

  it("does not wait for a background process the command left behind, and stops it when the command exits", async () => {
    const marker = join(scratch(), "background-still-running");
    const started = Date.now();
    // The shell exits at once; its background child would write the marker after 0.4 s, inside the time limit.
    const run = await runHook("talking-stopped", null, `(sleep 0.4; touch '${marker}') &`);
    expect(run).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(() => readFileSync(marker)).toThrow();
  });

  it("leaves nothing behind when the worker is disposed, a command's background child included", async () => {
    const marker = join(scratch(), "after-dispose");
    const harness = experimental_createHostEntryHarness(hostEntry);
    let running: Promise<unknown> = Promise.resolve();
    try {
      running = harness.experimental_call("run", { command: `(sleep 0.4; touch '${marker}') & sleep 30`, event: "speaking-started", reason: null });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await harness.experimental_dispose();
    }
    await expect(running).resolves.toMatchObject({ signal: "SIGKILL" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(() => readFileSync(marker)).toThrow();
  });

  it("reports a command that could not be started", async () => {
    const run = await runHook("listening-started", null, "true", { cwd: join(scratch(), "missing") });
    expect(run).toMatchObject({ failedToStart: true, exitCode: null });
  });

  it("is killed with the others when the worker goes", async () => {
    const running = runHook("speaking-started", null, "sleep 30");
    killRunningHooks();
    await expect(running).resolves.toMatchObject({ signal: "SIGKILL", timedOut: false });
  });

  it("runs through the host entry, and stops what is still running when the worker is disposed", async () => {
    const out = join(scratch(), "out");
    const harness = experimental_createHostEntryHarness(hostEntry);
    let slow: Promise<unknown> = Promise.resolve();
    try {
      await expect(
        harness.experimental_call("run", { command: `echo "$FIRSTMATE_VOICE_HOOK" >> '${out}'`, event: "listening-started", reason: null }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(readFileSync(out, "utf8")).toBe("listening-started\n");
      slow = harness.experimental_call("run", { command: "sleep 30", event: "speaking-started", reason: null });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await harness.experimental_dispose();
    }
    await expect(slow).resolves.toMatchObject({ signal: "SIGKILL" });
  });
});
