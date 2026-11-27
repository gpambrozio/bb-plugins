import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HOOK_EDIT_MAX, HookWriteSchema } from "../shared/hooks";
import { readHookFile, writeHookFile } from "./hook-file";

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "vp-edit-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".config", "voice-pilot"), { recursive: true });
  return dir;
}
function put(at: string, name: string, body: string | Buffer, mode = 0o755): string {
  const file = join(at, ".config", "voice-pilot", name);
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const modeOf = (file: string) => statSync(file).mode & 0o7777;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(join(dir, ".config", "voice-pilot"), 0o755);
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loading the hook script for the editor", () => {
  it("loads the hook that runs, as text with its hash and whether it is executable", async () => {
    const at = home();
    const body = "#!/bin/sh\necho hi\n";
    const file = put(at, "hook.sh", body);
    await expect(readHookFile(at)).resolves.toEqual({ kind: "text", name: "hook.sh", path: file, content: body, sha256: sha(body), executable: true });
    put(at, "hook", "#!/bin/sh\n", 0o644);
    await expect(readHookFile(at)).resolves.toMatchObject({ kind: "text", name: "hook", executable: false });
  });

  it("says when there is none, and does not load one that is too large or not text", async () => {
    const at = home();
    await expect(readHookFile(at)).resolves.toEqual({ kind: "missing" });
    put(at, "hook", Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    await expect(readHookFile(at)).resolves.toEqual({ kind: "unsupported", name: "hook", reason: "It is not UTF-8 text." });
    put(at, "hook", "x".repeat(HOOK_EDIT_MAX + 1));
    await expect(readHookFile(at)).resolves.toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/larger than/u) });
  });
});

describe("saving the hook script from the editor", () => {
  it("writes the new text and keeps the file's permissions: an executable hook stays executable", async () => {
    const at = home();
    const file = put(at, "hook.sh", "#!/bin/sh\necho old\n", 0o750);
    const result = await writeHookFile({ name: "hook.sh", content: "#!/bin/sh\necho new\n", expectedSha256: sha("#!/bin/sh\necho old\n") }, at);
    expect(result).toEqual({ outcome: "written", sha256: sha("#!/bin/sh\necho new\n"), executable: true });
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho new\n");
    expect(modeOf(file)).toBe(0o750);
  });

  it("keeps a file that is not executable as it is", async () => {
    const at = home();
    const file = put(at, "hook", "a", 0o640);
    await expect(writeHookFile({ name: "hook", content: "b", expectedSha256: sha("a") }, at)).resolves.toMatchObject({ outcome: "written", executable: false });
    expect(modeOf(file)).toBe(0o640);
  });

  it("writes through a link, leaving it a link", async () => {
    const at = home();
    const target = join(at, "real-hook.sh");
    writeFileSync(target, "a");
    chmodSync(target, 0o755);
    symlinkSync(target, join(at, ".config", "voice-pilot", "hook.sh"));
    await writeHookFile({ name: "hook.sh", content: "b", expectedSha256: sha("a") }, at);
    expect(readFileSync(target, "utf8")).toBe("b");
    expect(modeOf(target)).toBe(0o755);
  });

  it("writes nothing when the file changed on disk since it was loaded, and says what it has now", async () => {
    const at = home();
    const file = put(at, "hook.sh", "changed elsewhere");
    await expect(writeHookFile({ name: "hook.sh", content: "mine", expectedSha256: sha("as loaded") }, at)).resolves.toEqual({ outcome: "conflict", currentSha256: sha("changed elsewhere") });
    expect(readFileSync(file, "utf8")).toBe("changed elsewhere");
  });

  it("writes nothing when the file is gone, and never creates one", async () => {
    const at = home();
    await expect(writeHookFile({ name: "hook.py", content: "mine", expectedSha256: sha("as loaded") }, at)).resolves.toEqual({ outcome: "conflict", currentSha256: null });
    await expect(readHookFile(at)).resolves.toEqual({ kind: "missing" });
  });

  it("reports a write the machine refused, instead of throwing", async () => {
    const at = home();
    const file = put(at, "hook", "a", 0o555);
    const result = await writeHookFile({ name: "hook", content: "b", expectedSha256: sha("a") }, at);
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/EACCES/u) });
    expect(readFileSync(file, "utf8")).toBe("a");
  });

  it("takes a hook file's name only, never a path", () => {
    expect(() => HookWriteSchema.parse({ name: "../../.zshrc", content: "x", expectedSha256: sha("a") })).toThrow();
    expect(() => HookWriteSchema.parse({ name: "hook", path: "/etc/hosts", content: "x", expectedSha256: sha("a") })).toThrow();
    expect(HookWriteSchema.parse({ name: "hook.rb", content: "x", expectedSha256: sha("a") }).name).toBe("hook.rb");
  });
});
