import { describe, expect, it } from "vitest";

import { createRunCommand } from "./run-command";

const onUnix = process.platform !== "win32";

describe.skipIf(!onUnix)("createRunCommand", () => {
  const run = createRunCommand(100);

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
