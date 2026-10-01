// launchd-jobs — the host entry.
//
// Runs on the Mac whose jobs are being managed, in a worker bb's host daemon
// starts there: `launchctl` acts on that machine's launchd, and the plists,
// runner, logs and history are that machine's files. The server entry calls it
// with the host's id. What each method does lives in host/jobs.ts.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { createLogFollows } from "./host/follow";
import { createJobs, type Jobs } from "./host/jobs";
import { createRunCommand } from "./host/run-command";
import { hostContract, hostSignals } from "./shared/host-contract";

const runCommand = createRunCommand();

function warn(message: string): void {
  console.warn(`[launchd-jobs] ${message}`);
}

/** Built on the first call, once bb has said where this plugin's data directory is. */
let jobs: Jobs | null = null;
let ownDir = "";

function jobsIn(dataDir: string): Jobs {
  if (jobs === null) {
    ownDir = dataDir;
    // Where the Paseo plugin keeps its jobs' files, now and before its own move.
    const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
    jobs = createJobs({
      ownDir: dataDir,
      paseoDirs: [join(paseoHome, "plugin-data", "launchd-jobs"), join(paseoHome, "plugins", "launchd-jobs")],
      launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
      platform: process.platform,
      uid: process.getuid?.(),
      run: runCommand,
      envPath: process.env.PATH,
      warn,
    });
  }
  return jobs;
}

const follows = createLogFollows(warn);

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    list: (_input, context) => jobsIn(context.experimental_paths.dataDir).list(),
    create: (input, context) => jobsIn(context.experimental_paths.dataDir).create(input, context.signal),
    update: (input, context) => jobsIn(context.experimental_paths.dataDir).update(input, context.signal),
    delete: async (input, context) => {
      follows.unfollow(input.id);
      return jobsIn(context.experimental_paths.dataDir).delete(input, context.signal);
    },
    run: (input, context) => jobsIn(context.experimental_paths.dataDir).run(input, context.signal),
    setEnabled: (input, context) => jobsIn(context.experimental_paths.dataDir).setEnabled(input, context.signal),
    log: (input, context) => jobsIn(context.experimental_paths.dataDir).log(input),
    follow: async (input, context) => {
      const all = jobsIn(context.experimental_paths.dataDir);
      await all.assertKnown(input.id);
      const logPath = all.logPath(await all.dataDirFor(input.id), input.id);
      // A job made here may not have run yet; its directory is ours to make.
      // An adopted job's directory is never created or changed from here.
      if (dirname(dirname(logPath)) === ownDir) await mkdir(dirname(logPath), { recursive: true });
      const expiresInMs = await follows.follow(input.id, logPath, {
        watch: (options, listener) => context.experimental_watch(options, listener),
        changed: () => context.experimental_emitSignal("logChanged", { id: input.id }),
      });
      return { expiresInMs };
    },
    unfollow: (input) => {
      follows.unfollow(input.id);
      return {};
    },
    health: (_input, context) => jobsIn(context.experimental_paths.dataDir).health(),
    acknowledge: (input, context) => jobsIn(context.experimental_paths.dataDir).acknowledge(input, context.signal),
  },
  dispose: () => follows.dispose(),
});
