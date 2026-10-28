/**
 * bb 0.47 has no shared host toolchain, so nothing has read the login shell's PATH into the one the SDK
 * bundles: the first watch must. Its own file, so the toolchain this process holds has read nothing yet.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWatchScript } from "./watch-run";

let root: string;
const saved = { SHELL: process.env.SHELL, LOGIN_ONLY_DIR: process.env.LOGIN_ONLY_DIR };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "firstmate-toolchain-"));
  // A tool only the login shell's PATH reaches.
  const loginOnly = join(root, "login-only");
  await mkdir(loginOnly);
  await writeFile(join(loginOnly, "logintool"), "#!/bin/sh\necho found\n", "utf8");
  await chmod(join(loginOnly, "logintool"), 0o755);
  // The login shell: it puts that folder on PATH, as a profile would, then runs what it was asked to.
  const shell = join(root, "login-shell");
  await writeFile(shell, '#!/bin/sh\nPATH="$LOGIN_ONLY_DIR:$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n', "utf8");
  await chmod(shell, 0o755);
  process.env.SHELL = shell;
  process.env.LOGIN_ONLY_DIR = loginOnly;
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("the first watch run", () => {
  it("finds a command only the login shell's PATH has, though the script says so only by exiting 1", async () => {
    const watch = join(root, "watch");
    await writeFile(watch, "#!/bin/sh\ncommand -v logintool >/dev/null || { echo 'logintool is missing' >&2; exit 1; }\nlogintool\n", "utf8");
    await chmod(watch, 0o755);

    const result = await runWatchScript(watch, {
      cwd: root,
      env: { ...process.env, FIRSTMATE_WATCH_NAME: "watch" },
      timeoutMs: 10_000,
      maxOutputBytes: 64_000,
      maxErrorBytes: 4000,
    });

    expect(result).toMatchObject({ code: 0, stdout: "found\n", stderr: "" });
  });
});
