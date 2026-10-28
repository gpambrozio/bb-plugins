import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runWatchScript } from "./watch-run";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function script(body: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "firstmate-run-"));
  tempDirs.push(dir);
  const path = join(dir, "watch");
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return { dir, path };
}

const LIMITS = { timeoutMs: 10_000, maxOutputBytes: 64_000, maxErrorBytes: 4000 };

describe("runWatchScript", () => {
  it("runs the script with bb's toolchain PATH: the given one first, then the places bb looks for tools", async () => {
    const { dir, path } = await script('printf %s "$PATH"');
    const result = await runWatchScript(path, { cwd: dir, env: { HOME: dir, PATH: "/nowhere" }, ...LIMITS });
    expect(result).toMatchObject({ code: 0, spawnError: null });
    const entries = result.stdout.split(":");
    expect(entries[0]).toBe("/nowhere");
    expect(entries).toContain(join(dir, ".local", "bin"));
    expect(entries).toContain("/usr/bin");
  });

  it("stops a script that runs past its time, and the processes it started", async () => {
    const { dir, path } = await script("sleep 30 &\nwait");
    const started = Date.now();
    const result = await runWatchScript(path, { cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin" }, ...LIMITS, timeoutMs: 200, killGraceMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
