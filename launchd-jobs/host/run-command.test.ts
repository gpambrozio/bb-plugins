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

describe.skipIf(!onUnix)("createRunCommand", () => {
  const run = createRunCommand();

  it("answers a command's output, and keeps its exit status on failure", async () => {
    expect(await run("/bin/sh", ["-c", "echo hi"])).toEqual({ stdout: "hi\n" });
    await expect(run("/bin/sh", ["-c", "echo oops >&2; exit 113"])).rejects.toMatchObject({ code: 113, stderr: "oops\n" });
  });

  it("never reports success for a command that ran out of time, even one that would exit 0 when told to stop", async () => {
    const script = "trap 'exit 0' TERM; while true; do sleep 0.05; done";
    const startedAt = Date.now();
    await expect(run("/bin/sh", ["-c", script], { timeoutMs: 150 })).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("does not keep its caller waiting on a helper the command left holding its output", async () => {
    scratch = await mkdtemp(join(tmpdir(), "run-command-"));
    const pidFile = join(scratch, "helper.pid");
    // The shell starts a helper that inherits its stdout, then waits for it.
    const script = 'sleep 30 & echo $! > "$1"; wait';
    const startedAt = Date.now();
    const running = run("/bin/sh", ["-c", script, "sh", pidFile], { timeoutMs: 150 });

    await expect(running).rejects.toBeDefined();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const helper = Number((await readFile(pidFile, "utf8")).trim());
    if (helper > 0) started.push(helper);
  });

  it("caps the output it keeps, failing the command that exceeds it", async () => {
    const small = createRunCommand({ maxBuffer: 1024 });
    const failure = await small("/bin/sh", ["-c", "yes"]).then(
      () => null,
      (error: { stdout?: string }) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure?.stdout?.length ?? 0).toBeLessThanOrEqual(1024);
  });
});
