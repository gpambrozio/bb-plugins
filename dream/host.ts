// Dream — the host entry.
//
// Runs on the dream machine, chosen in the plugin's settings, in a worker bb's host daemon starts
// there: Claude Code's `~/.claude`, the memory folders, the checkouts and this plugin's backups and
// proposals are that machine's files. The server entry calls it with the machine's host id; what each
// method does lives in host/dreams.ts.
import { homedir } from "node:os";

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { createDreams, DreamRefusal, type Dreams } from "./host/dreams";
import { GUARD_SOURCE } from "./host/guard-source";
import { managedSettingsDirs } from "./host/memory";
import { hostContract } from "./shared/host-contract";

/** Built on the first call, once bb has said where this plugin's data directory is. */
let dreams: Dreams | null = null;

function dreamsIn(dataDir: string): Dreams {
  if (dreams === null) {
    dreams = createDreams({
      dataDir,
      home: homedir(),
      env: {
        CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_REMOTE_MEMORY_DIR: process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
      },
      managedDirs: managedSettingsDirs(process.platform),
      platform: process.platform,
      pid: process.pid,
      // The guard runs on the daemon's own Node: bb.app's is Electron, which needs ELECTRON_RUN_AS_NODE.
      nodePath: process.execPath,
      electron: typeof process.versions.electron === "string",
      guardSource: GUARD_SOURCE,
    });
  }
  return dreams;
}

/** A refusal is an answer, not a crash: its message reaches the caller as the error. */
async function answer<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DreamRefusal) throw new Error(error.message);
    throw error;
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: (_input, context) => dreamsIn(context.experimental_paths.dataDir).scan(),
    status: (input, context) => ({ projects: dreamsIn(context.experimental_paths.dataDir).status(input.projects, input.thresholds) }),
    // The lease is taken here, while the call that starts the dream runs; `finish` releases it.
    prepare: (input, context) =>
      dreamsIn(context.experimental_paths.dataDir).prepare(input, () => {
        const lease = context.experimental_retainWorker();
        return () => void lease.dispose();
      }),
    finish: (input, context) => dreamsIn(context.experimental_paths.dataDir).finish(input),
    checkCanary: (input, context) => dreamsIn(context.experimental_paths.dataDir).checkCanary(input.runId),
    apply: (input, context) =>
      answer(() => dreamsIn(context.experimental_paths.dataDir).apply(input.project, input.stamp, input.backupsToKeep)),
    discard: (input, context) => answer(() => dreamsIn(context.experimental_paths.dataDir).discard(input.project, input.stamp)),
    restore: (input, context) =>
      answer(() => dreamsIn(context.experimental_paths.dataDir).restore(input.project, input.stamp, input.backupsToKeep)),
    backups: (input, context) => dreamsIn(context.experimental_paths.dataDir).backups(input.project),
    activeRuns: (_input, context) => ({ runs: dreamsIn(context.experimental_paths.dataDir).activeRuns() }),
  },
  dispose: () => dreams?.dispose(),
});
