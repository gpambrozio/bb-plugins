/**
 * The settings' hook editor, on the machine whose hook it is: loads the hook file that runs there and saves it
 * back. Only files in `~/.config/voice-pilot/` with one of `HOOK_NAMES` are read or written, never a path
 * from a caller. A save writes the file in place, so it keeps its permissions (an executable hook stays
 * executable) and a link stays a link, and puts the mode back explicitly as well. It writes only when the file
 * on disk still has the hash it was loaded with; otherwise it reports a conflict and writes nothing.
 */
import { createHash } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { HOOK_DIR, HOOK_EDIT_MAX, type HookFileRead, type HookName, type HookWrite, type HookWriteResult } from "../shared/hooks";
import { hookStatus } from "./run-hook";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileOf(name: HookName, home: string): string {
  return join(home, ...HOOK_DIR.split("/"), name);
}

/** The bytes of `file`, or null when there is no such file. */
async function bytesOf(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The hook file that runs here (the first of `HOOK_NAMES`), as text with its hash. */
export async function readHookFile(home: string = homedir()): Promise<HookFileRead> {
  const status = await hookStatus(home);
  if (!status.present || status.path === undefined) return { kind: "missing" };
  const name = status.path.split("/").at(-1) as HookName;
  let bytes: Buffer | null;
  try {
    if ((await stat(status.path)).size > HOOK_EDIT_MAX) return { kind: "unsupported", name, reason: `It is larger than ${HOOK_EDIT_MAX / 1024} KB.` };
    bytes = await bytesOf(status.path);
  } catch (error) {
    return { kind: "unsupported", name, reason: `It could not be read: ${reasonOf(error)}` };
  }
  if (bytes === null) return { kind: "missing" };
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) return { kind: "unsupported", name, reason: "It is not UTF-8 text." };
  return { kind: "text", name, path: status.path, content, sha256: sha256(bytes), executable: status.executable };
}

/** Saves `content` to hook file `name` when it still has `expectedSha256`; keeps its mode. */
export async function writeHookFile(input: HookWrite, home: string = homedir()): Promise<HookWriteResult> {
  const file = fileOf(input.name, home);
  try {
    const current = await bytesOf(file);
    const currentSha256 = current === null ? null : sha256(current);
    if (currentSha256 !== input.expectedSha256) return { outcome: "conflict", currentSha256 };
    const mode = (await stat(file)).mode & 0o7777;
    const bytes = Buffer.from(input.content, "utf8");
    await writeFile(file, bytes);
    await chmod(file, mode);
    return { outcome: "written", sha256: sha256(bytes), executable: (mode & 0o111) !== 0 };
  } catch (error) {
    return { outcome: "failed", reason: reasonOf(error) };
  }
}

/** An error in a line: its code and message, never a stack. */
function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (code !== undefined && !message.includes(code) ? `${code}: ${message}` : message).slice(0, 280);
}
