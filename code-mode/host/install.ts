// Writes the wrapper into this plugin's host-data folder on the machine the host entry runs on, and
// says where the launcher is. Every check rewrites a file only when its text or mode differs, through a
// temporary file and a rename, so a claude launch reading the old copy never sees half a file. The
// launcher names the host daemon's own Node by absolute path, which can move when bb updates, so the
// server checks again on each load.
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { InstallResult } from "../shared/host-contract";
import { launcherScript } from "./launcher";
import { WRAPPER_SOURCE } from "./wrapper.generated";

export const LAUNCHER_NAME = "bb-claude-code-mode";
export const SCRIPT_NAME = "code-mode-wrapper.mjs";

export interface InstallInput {
  dataDir: string;
  /** The host daemon's Node (`process.execPath`). */
  node: string;
  platform: NodeJS.Platform;
}

async function writeIfChanged(path: string, text: string, mode: number): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === text) {
    const { mode: now } = await stat(path);
    if ((now & 0o777) !== mode) await chmod(path, mode);
    return;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function installWrapper({ dataDir, node, platform }: InstallInput): Promise<InstallResult> {
  if (platform === "win32") return { ok: false, reason: "Code Mode's wrapper needs a POSIX shell, and this machine runs Windows." };
  try {
    await access(node, constants.X_OK);
  } catch {
    return { ok: false, reason: `This machine's bb has no Node the wrapper can use at ${node}.` };
  }
  const script = join(dataDir, SCRIPT_NAME);
  const launcher = join(dataDir, LAUNCHER_NAME);
  try {
    await mkdir(dataDir, { recursive: true });
    await writeIfChanged(script, WRAPPER_SOURCE, 0o644);
    await writeIfChanged(launcher, launcherScript({ node, script }), 0o755);
    await access(launcher, constants.X_OK);
  } catch (error) {
    return { ok: false, reason: `Could not write the wrapper into ${dataDir}: ${describe(error)}` };
  }
  return { ok: true, path: launcher };
}
