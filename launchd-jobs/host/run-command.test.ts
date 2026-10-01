import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRunCommand } from "./run-command";

const onUnix = process.platform !== "win32";

/** PIDs this file's own commands started, killed in cleanup if a test left one running. */
const started: number[] = [];
let scratch = "";

afterEach(async () => {
  for (const pid of started.splice(0)) {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
  scratch = "";
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

describe.skipIf(!onUnix)("createRunCommand", () => {
  const run = createRunCommand(100);

  it("stops what the command started too, and lets go of its output pipes", async () => {
    scratch = await mkdtemp(join(tmpdir(), "run-command-"));
    const pidFile = join(scratch, "descendant.pid");
    // A shell that starts a helper which ignores SIGTERM and holds the shell's stdout, then waits.
    const script = 'trap "" TERM; sleep 30 & echo $! > "$1"; wait';
    const startedAt = Date.now();
    const running = run("/bin/sh", ["-c", script, "sh", pidFile], { timeoutMs: 200 });
    let descendant = 0;
    await waitFor(async () => {
      descendant = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
      return descendant > 0;
    }, 2_000);
    expect(descendant).toBeGreaterThan(0);
    started.push(descendant);

    await expect(running).rejects.toThrow(/timed out/);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await waitFor(async () => !alive(descendant), 1_000)).toBe(true);
  });

  it("never reports success for a command it stopped, even one that exits 0 on SIGTERM", async () => {
    const script = "trap 'exit 0' TERM; while true; do sleep 0.05; done";
    await expect(run("/bin/sh", ["-c", script], { timeoutMs: 150 })).rejects.toThrow(/timed out/);

    const cancel = new AbortController();
    const running = run("/bin/sh", ["-c", script], { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 100);
    await expect(running).rejects.toThrow(/was cancelled/);
  });

  it("answers a command's output, and keeps its exit status on failure", async () => {
    expect(await run("/bin/sh", ["-c", "echo hi"])).toEqual({ stdout: "hi\n" });
    await expect(run("/bin/sh", ["-c", "echo oops >&2; exit 113"])).rejects.toMatchObject({ code: 113, stderr: "oops\n" });
  });

  it("gives up on a child that ignores SIGTERM, within its timeout and two graces", async () => {
    const started = Date.now();
    await expect(run("/bin/sh", ["-c", "trap '' TERM; exec sleep 30"], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops a running command when its signal aborts, and spawns nothing for one already aborted", async () => {
    const cancel = new AbortController();
    const running = run("/bin/sh", ["-c", "trap '' TERM; exec sleep 30"], { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 50);
    await expect(running).rejects.toThrow(/was cancelled/);

    await expect(run("/bin/sh", ["-c", "echo never"], { signal: cancel.signal })).rejects.toThrow(/before it started/);
  });
});
