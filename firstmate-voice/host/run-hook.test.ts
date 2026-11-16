import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import hostEntry from "../host";
import { hookPath, hookStatus, killRunningHooks, runHook } from "./run-hook";

const posix = process.platform !== "win32";
let dirs: string[] = [];
const realHome = process.env.HOME;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fmv-hook-"));
  dirs.push(dir);
  return dir;
}

/** Writes a hook script; executable unless asked otherwise. */
function hookFile(body: string, options: { home?: string; executable?: boolean } = {}): string {
  const file = hookPath(options.home ?? scratch());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, options.executable === false ? 0o644 : 0o755);
  return file;
}

afterEach(() => {
  process.env.HOME = realHome;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe.runIf(posix)("running a machine's voice hook", () => {
  it("is the file ~/.config/firstmate-voice/hook in the home folder", () => {
    expect(hookPath("/Users/someone")).toBe("/Users/someone/.config/firstmate-voice/hook");
    expect(hookPath()).toBe(join(homedir(), ".config", "firstmate-voice", "hook"));
  });

  it("says whether the file is there and runnable, and nothing of what is in it", async () => {
    const home = scratch();
    await expect(hookStatus(hookPath(home))).resolves.toEqual({ present: false, executable: false });
    hookFile("echo secret", { home, executable: false });
    await expect(hookStatus(hookPath(home))).resolves.toEqual({ present: true, executable: false });
    chmodSync(hookPath(home), 0o755);
    await expect(hookStatus(hookPath(home))).resolves.toEqual({ present: true, executable: true });
    // A folder at the path is not a hook.
    const other = scratch();
    mkdirSync(hookPath(other), { recursive: true });
    await expect(hookStatus(hookPath(other))).resolves.toEqual({ present: false, executable: false });
  });

  it("runs nothing, and answers null, when there is no hook file", async () => {
    await expect(runHook("listening-started", null, { file: hookPath(scratch()) })).resolves.toBeNull();
  });

  it("runs the file from the home folder, with the moment and the reason set", async () => {
    const out = join(scratch(), "out");
    const file = hookFile(`printf '%s|%s|%s' "$FIRSTMATE_VOICE_HOOK" "$FIRSTMATE_VOICE_REASON" "$PWD" > '${out}'`);
    const run = await runHook("listening-stopped", "ended by the captain", { file });
    expect(run).toMatchObject({ exitCode: 0, signal: null, timedOut: false, failedToStart: false });
    expect(readFileSync(out, "utf8")).toBe(`listening-stopped|ended by the captain|${homedir()}`);
  });

  it("sets no reason on a moment that has none, even one left in the environment", async () => {
    const out = join(scratch(), "out");
    const file = hookFile(`printf '%s' "\${FIRSTMATE_VOICE_REASON-unset}" > '${out}'`);
    await runHook("speaking-started", null, { file, env: { ...process.env, FIRSTMATE_VOICE_REASON: "stale" } });
    expect(readFileSync(out, "utf8")).toBe("unset");
  });

  it("reports the exit status, and never the output", async () => {
    const run = await runHook("talking-started", null, { file: hookFile("echo 'a secret'; echo 'another' >&2; exit 3") });
    expect(run).toEqual({ exitCode: 3, signal: null, timedOut: false, failedToStart: false, durationMs: expect.any(Number) });
  });

  it("reports a file that is there but not executable as not started", async () => {
    const run = await runHook("talking-started", null, { file: hookFile("exit 0", { executable: false }) });
    expect(run).toMatchObject({ failedToStart: true, exitCode: null });
  });

  it("stops a hook that runs out of time, with what it started", async () => {
    const marker = join(scratch(), "child-still-running");
    const started = Date.now();
    const run = await runHook("speaking-started", null, { file: hookFile(`(sleep 1; touch '${marker}') & sleep 30`), timeoutMs: 200 });
    expect(run).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(() => readFileSync(marker)).toThrow();
  });

  it("does not wait for a background process the hook left behind, and stops it when the hook exits", async () => {
    const marker = join(scratch(), "background-still-running");
    const started = Date.now();
    // The hook exits at once; its background child would write the marker after 0.4 s, inside the time limit.
    const run = await runHook("talking-stopped", null, { file: hookFile(`(sleep 0.4; touch '${marker}') &`) });
    expect(run).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(() => readFileSync(marker)).toThrow();
  });

  it("is killed with the others when the worker goes", async () => {
    const running = runHook("speaking-started", null, { file: hookFile("sleep 30") });
    await new Promise((resolve) => setTimeout(resolve, 100));
    killRunningHooks();
    await expect(running).resolves.toMatchObject({ signal: "SIGKILL", timedOut: false });
  });

  it("runs only the machine's own file through the host entry, and leaves nothing behind when the worker is disposed", async () => {
    const home = scratch();
    process.env.HOME = home;
    const out = join(scratch(), "out");
    const marker = join(scratch(), "after-dispose");
    const harness = experimental_createHostEntryHarness(hostEntry);
    let slow: Promise<unknown> = Promise.resolve();
    try {
      await expect(harness.experimental_call("status", {})).resolves.toEqual({ present: false, executable: false });
      await expect(harness.experimental_call("run", { event: "listening-started", reason: null })).resolves.toBeNull();
      hookFile(`echo "$FIRSTMATE_VOICE_HOOK" >> '${out}'; if [ "$FIRSTMATE_VOICE_HOOK" = speaking-started ]; then (sleep 0.4; touch '${marker}') & sleep 30; fi`, { home });
      await expect(harness.experimental_call("status", {})).resolves.toEqual({ present: true, executable: true });
      await expect(harness.experimental_call("run", { event: "listening-started", reason: null })).resolves.toMatchObject({ exitCode: 0 });
      expect(readFileSync(out, "utf8")).toBe("listening-started\n");
      // No call can name a command or a path: the contract refuses one.
      await expect(harness.experimental_call("run", { event: "talking-started", reason: null, command: "touch /tmp/x" } as never)).rejects.toThrow();
      slow = harness.experimental_call("run", { event: "speaking-started", reason: null });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await harness.experimental_dispose();
    }
    await expect(slow).resolves.toMatchObject({ signal: "SIGKILL" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(() => readFileSync(marker)).toThrow();
  });
});
