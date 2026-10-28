/**
 * A plugin that stops while bb's toolchain is still reading a slow login shell starts no watch, and does
 * not wait for the shell. Its own file, so the toolchain this process holds has read nothing yet.
 */
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWatchScript } from "./watch-run";

let root: string;
const savedShell = process.env.SHELL;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "firstmate-toolchain-abort-"));
  const shell = join(root, "slow-shell");
  await writeFile(shell, "#!/bin/sh\nsleep 30\n", "utf8");
  await chmod(shell, 0o755);
  process.env.SHELL = shell;
});

afterAll(async () => {
  if (savedShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = savedShell;
  await rm(root, { recursive: true, force: true });
});

describe("the first watch run", () => {
  it("starts nothing, at once, when the plugin stops while the login shell is still being read", async () => {
    const marker = join(root, "ran");
    const watch = join(root, "watch");
    await writeFile(watch, `#!/bin/sh\ntouch '${marker}'\n`, "utf8");
    await chmod(watch, 0o755);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();

    const result = await runWatchScript(watch, {
      cwd: root,
      env: { ...process.env },
      timeoutMs: 10_000,
      maxOutputBytes: 64_000,
      maxErrorBytes: 4000,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ code: null, spawnError: "the plugin stopped" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(marker)).toBe(false);
  });
});
