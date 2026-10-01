import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeLaunchd, FAKE_LOGIN_PATH, FAKE_UID } from "./fake-launchd";
import {
  commandOf,
  createJobs,
  dataDirOf,
  DIR_VARIABLE,
  LABEL_PREFIX,
  plistXml,
  readChunk,
  readRuns,
  RUNNER_SCRIPT,
  type Jobs,
} from "./jobs";

const exec = promisify(execFile);
const onMac = process.platform === "darwin";

let root = "";
let agents = "";
let ownDir = "";
/** Shaped like the Paseo plugin's data directory: runner.sh, jobs.json, acknowledged.json, logs/, runs/. */
let paseoDir = "";
let launchd: ReturnType<typeof createFakeLaunchd>;
let jobs: Jobs;
const warnings: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "launchd-jobs-"));
  agents = join(root, "LaunchAgents");
  ownDir = join(root, "bb", "plugins", "launchd-jobs", "host-data");
  paseoDir = join(root, "paseo", "plugin-data", "launchd-jobs");
  await mkdir(agents, { recursive: true });
  launchd = createFakeLaunchd();
  warnings.length = 0;
  jobs = createJobs({
    ownDir,
    launchAgentsDir: agents,
    platform: "darwin",
    uid: FAKE_UID,
    run: launchd.run,
    envPath: "/usr/bin:/bin",
    warn: (message) => warnings.push(message),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

function plistPath(slug: string): string {
  return join(agents, `${LABEL_PREFIX}${slug}.plist`);
}

function runLine(startedAt: string, exitCode: number, durationMs = 1200): string {
  const finishedAt = startedAt.replace(/:00Z$/, ":01Z");
  return `${JSON.stringify({ startedAt, finishedAt, exitCode, durationMs })}\n`;
}

/** Every file under `dir` with its content hash and mtime, to prove nothing in it changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const [content, info] = await Promise.all([readFile(path), stat(path)]);
        out[path.slice(dir.length)] = `${createHash("sha256").update(content).digest("hex")}@${info.mtimeMs}`;
      }
    }
  }
  await walk(dir);
  return out;
}

async function readPlistJson(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
  return JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * Two jobs the Paseo plugin made, as it leaves them on disk: plists under the
 * shared prefix whose runner, data directory and stderr log are absolute paths
 * into its own directory, with names, an acknowledgement, logs and history
 * there. Made-up content throughout.
 */
async function paseoInstall(): Promise<void> {
  const spec = (name: string, command: string, expression: string) => ({
    name,
    command,
    cwd: null,
    schedule: { type: "cron" as const, expression },
  });
  await put(join(paseoDir, "runner.sh"), "#!/bin/zsh\n# Written by the launchd-jobs Paseo plugin\n");
  await put(join(paseoDir, "jobs.json"), JSON.stringify({ names: { "nightly-report": "Nightly report", "sync-notes": "Sync notes" } }));
  await put(join(paseoDir, "acknowledged.json"), JSON.stringify({ acknowledged: { "sync-notes": "2026-01-02T03:00:00Z" } }));
  await put(
    join(paseoDir, "logs", "nightly-report.log"),
    "=== 2026-01-01T02:00:00Z start\nreport written\n=== 2026-01-01T02:00:01Z exit 0\n=== 2026-01-02T02:00:00Z start\nfailed to reach the server\n=== 2026-01-02T02:00:01Z exit 1\n",
  );
  await put(join(paseoDir, "runs", "nightly-report.jsonl"), runLine("2026-01-01T02:00:00Z", 0) + runLine("2026-01-02T02:00:00Z", 1));
  await put(join(paseoDir, "logs", "sync-notes.log"), "=== 2026-01-02T03:00:00Z start\n=== 2026-01-02T03:00:01Z exit 2\n");
  await put(join(paseoDir, "runs", "sync-notes.jsonl"), runLine("2026-01-02T03:00:00Z", 2));
  for (const [slug, job] of [
    ["nightly-report", spec("Nightly report", "make-report --all", "0 2 * * *")],
    ["sync-notes", spec("Sync notes", "sync-notes ~/notes", "0 3 * * 1-5")],
  ] as const) {
    await put(
      plistPath(slug),
      plistXml({ label: `${LABEL_PREFIX}${slug}`, slug, spec: job, dataDir: paseoDir, path: "/usr/local/bin:/usr/bin:/bin" }),
    );
    launchd.loaded.set(`${LABEL_PREFIX}${slug}`, { running: false, runs: 4, lastExitCode: slug === "sync-notes" ? 2 : 1 });
  }
}

describe.skipIf(!onMac)("adopting the Paseo plugin's jobs", () => {
  it("lists them with their names, schedules, launchd status and run history from the Paseo directory", async () => {
    await paseoInstall();

    const list = await jobs.list();

    expect(list.supported).toBe(true);
    expect(list.jobs.map((job) => job.id)).toEqual(["nightly-report", "sync-notes"]);
    const [report, notes] = list.jobs;
    expect(report).toMatchObject({
      name: "Nightly report",
      label: `${LABEL_PREFIX}nightly-report`,
      command: "make-report --all",
      managed: true,
      adopted: true,
      dataDir: paseoDir,
      logPath: join(paseoDir, "logs", "nightly-report.log"),
      loaded: true,
      disabled: false,
      runs: 4,
      lastExitCode: 1,
      schedule: { type: "cron", expression: "0 2 * * *" },
      problem: null,
    });
    expect(report?.recentRuns.map((run) => [run.startedAt, run.exitCode])).toEqual([
      ["2026-01-02T02:00:00Z", 1],
      ["2026-01-01T02:00:00Z", 0],
    ]);
    expect(notes).toMatchObject({ name: "Sync notes", adopted: true, recentRuns: [{ exitCode: 2 }] });
  });

  it("shows their log tail from the Paseo directory", async () => {
    await paseoInstall();

    const log = await jobs.log({ id: "nightly-report" });

    expect(log.path).toBe(join(paseoDir, "logs", "nightly-report.log"));
    expect(log.text).toContain("failed to reach the server\n=== 2026-01-02T02:00:01Z exit 1\n");
    expect(log.truncated).toBe(false);
  });

  it("counts a failure the Paseo plugin's user has not seen, and not one they acknowledged there", async () => {
    await paseoInstall();

    const health = await jobs.health();

    expect(health).toEqual({ supported: true, jobCount: 2, failing: [{ id: "nightly-report", name: "Nightly report" }] });
  });

  it("changes nothing in the Paseo directory, or the plists, by listing, reading or counting", async () => {
    await paseoInstall();
    const before = await snapshot(root);

    await jobs.list();
    await jobs.log({ id: "nightly-report" });
    await jobs.log({ id: "sync-notes", from: 10 });
    await jobs.health();

    const after = await snapshot(root);
    expect(after).toEqual(before);
    expect(launchd.calls.every(([verb]) => verb === "print" || verb === "print-disabled")).toBe(true);
  });

  it("keeps an edited job's runner, log and history where they were, and records the new name here", async () => {
    await paseoInstall();
    const before = await snapshot(paseoDir);

    const job = await jobs.update({
      id: "nightly-report",
      spec: { name: "Nightly report v2", command: "make-report --all --quiet", cwd: "~/reports", schedule: { type: "cron", expression: "30 2 * * *" } },
    });

    expect(await snapshot(paseoDir)).toEqual(before);
    const plist = await readPlistJson(plistPath("nightly-report"));
    expect(plist.ProgramArguments).toEqual(["/bin/zsh", join(paseoDir, "runner.sh"), "nightly-report", "make-report --all --quiet"]);
    expect(plist.EnvironmentVariables).toEqual({ PATH: FAKE_LOGIN_PATH, [DIR_VARIABLE]: paseoDir });
    expect(plist.StandardErrorPath).toBe(join(paseoDir, "logs", "nightly-report.log"));
    expect(job).toMatchObject({ name: "Nightly report v2", adopted: true, managed: true, recentRuns: [{ exitCode: 1 }, { exitCode: 0 }] });
    expect(JSON.parse(await readFile(join(ownDir, "jobs.json"), "utf8"))).toEqual({ names: { "nightly-report": "Nightly report v2" } });
    // Update is bootout, rewrite, bootstrap — with the PATH probed first, so the job is not out of launchd for it.
    expect(launchd.calls.filter(([verb]) => ["bootout", "bootstrap", "path-probe"].includes(verb!)).map(([verb]) => verb)).toEqual([
      "path-probe",
      "bootout",
      "bootstrap",
    ]);
  });

  it("moves an edited job into its own directory only when the Paseo runner is gone", async () => {
    await paseoInstall();
    await rm(join(paseoDir, "runner.sh"));

    const job = await jobs.update({
      id: "sync-notes",
      spec: { name: "Sync notes", command: "sync-notes ~/notes", cwd: null, schedule: { type: "interval", seconds: 600 } },
    });

    expect(job).toMatchObject({ adopted: false, managed: true, dataDir: ownDir });
    expect(await readFile(join(ownDir, "runner.sh"), "utf8")).toBe(RUNNER_SCRIPT);
  });

  it("acknowledges in its own file, leaving the Paseo plugin's untouched", async () => {
    await paseoInstall();
    const before = await snapshot(paseoDir);

    await jobs.acknowledge({ id: "nightly-report" });

    expect(await snapshot(paseoDir)).toEqual(before);
    expect(JSON.parse(await readFile(join(ownDir, "acknowledged.json"), "utf8"))).toEqual({
      acknowledged: { "nightly-report": "2026-01-02T02:00:00Z" },
    });
    expect((await jobs.health()).failing).toEqual([]);
  });

  it("deletes an adopted job's own log and history with it, and nothing else of the Paseo plugin's", async () => {
    await paseoInstall();

    await jobs.delete({ id: "sync-notes" });

    expect((await jobs.list()).jobs.map((job) => job.id)).toEqual(["nightly-report"]);
    expect((await readdir(join(paseoDir, "logs"))).sort()).toEqual(["nightly-report.log"]);
    expect((await readdir(join(paseoDir, "runs"))).sort()).toEqual(["nightly-report.jsonl"]);
    expect(await readFile(join(paseoDir, "jobs.json"), "utf8")).toContain("sync-notes");
    expect(await readFile(join(paseoDir, "runner.sh"), "utf8")).toContain("Paseo");
  });
});

describe.skipIf(!onMac)("jobs made here", () => {
  const nightly = { name: "Back up notes!", command: "rsync -a ~/notes /tmp/backup", cwd: null, schedule: { type: "cron" as const, expression: "0 9 * * 1-5" } };

  it("writes the plist in the runner shape, with the login PATH and no StandardOutPath, and loads it", async () => {
    const job = await jobs.create(nightly);

    expect(job).toMatchObject({ id: "back-up-notes", name: "Back up notes!", managed: true, adopted: false, loaded: true, dataDir: ownDir });
    const plist = await readPlistJson(plistPath("back-up-notes"));
    expect(plist.Label).toBe(`${LABEL_PREFIX}back-up-notes`);
    expect(plist.ProgramArguments).toEqual(["/bin/zsh", join(ownDir, "runner.sh"), "back-up-notes", nightly.command]);
    expect(plist.EnvironmentVariables).toEqual({ PATH: FAKE_LOGIN_PATH, [DIR_VARIABLE]: ownDir });
    expect(plist.StandardOutPath).toBeUndefined();
    expect(plist.StandardErrorPath).toBe(join(ownDir, "logs", "back-up-notes.log"));
    expect(plist.StartCalendarInterval).toHaveLength(5);
    expect(await readFile(join(ownDir, "runner.sh"), "utf8")).toBe(RUNNER_SCRIPT);
    expect(launchd.calls).toContainEqual(["bootstrap", `gui/${FAKE_UID}`, plistPath("back-up-notes")]);
  });

  it("gives a second job of the same name its own slug", async () => {
    await jobs.create(nightly);
    expect((await jobs.create(nightly)).id).toBe("back-up-notes-2");
  });

  it("leaves the plist in place when launchd refuses it, so the list shows it unloaded", async () => {
    launchd.refuseBootstrap.add(`${LABEL_PREFIX}back-up-notes`);

    await expect(jobs.create(nightly)).rejects.toThrow(/bootstrap/);

    const [job] = (await jobs.list()).jobs;
    expect(job).toMatchObject({ id: "back-up-notes", loaded: false });
  });

  it("enables with `enable` before bootstrap, and disables with bootout before `disable`", async () => {
    await jobs.create(nightly);
    launchd.calls.length = 0;

    const off = await jobs.setEnabled({ id: "back-up-notes", enabled: false });
    expect(off).toMatchObject({ disabled: true, loaded: false });
    expect(launchd.calls.map(([verb]) => verb).filter((verb) => verb !== "print" && verb !== "print-disabled")).toEqual(["bootout", "disable"]);

    launchd.calls.length = 0;
    const on = await jobs.setEnabled({ id: "back-up-notes", enabled: true });
    expect(on).toMatchObject({ disabled: false, loaded: true });
    expect(launchd.calls.map(([verb]) => verb).filter((verb) => verb !== "print" && verb !== "print-disabled")).toEqual(["enable", "bootout", "bootstrap"]);
  });

  it("does not reload a disabled job it updates", async () => {
    await jobs.create(nightly);
    await jobs.setEnabled({ id: "back-up-notes", enabled: false });

    const job = await jobs.update({ id: "back-up-notes", spec: { ...nightly, command: "true" } });

    expect(job).toMatchObject({ disabled: true, loaded: false, command: "true" });
  });

  it("runs `enable` before removing a deleted job's plist, so a later job of that slug is not born disabled", async () => {
    await jobs.create(nightly);
    await jobs.setEnabled({ id: "back-up-notes", enabled: false });
    await put(join(ownDir, "logs", "back-up-notes.log"), "x\n");
    launchd.calls.length = 0;

    await jobs.delete({ id: "back-up-notes" });

    expect(launchd.calls.map(([verb]) => verb)).toEqual(["bootout", "enable"]);
    expect(launchd.disabled.size).toBe(0);
    expect((await jobs.list()).jobs).toEqual([]);
    expect(await readdir(join(ownDir, "logs"))).toEqual([]);
    expect(JSON.parse(await readFile(join(ownDir, "jobs.json"), "utf8"))).toEqual({ names: {} });
  });

  it("refuses to run a job launchd has not loaded", async () => {
    await jobs.create(nightly);
    await jobs.setEnabled({ id: "back-up-notes", enabled: false });
    await expect(jobs.run({ id: "back-up-notes" })).rejects.toThrow(/not loaded/);
  });

  it("refuses a cron expression the form would refuse, and a relative working directory", async () => {
    await expect(jobs.create({ ...nightly, schedule: { type: "cron", expression: "0 9 * *" } })).rejects.toThrow();
    await expect(jobs.create({ ...nightly, cwd: "notes" })).rejects.toThrow(/absolute/);
  });
});

describe.skipIf(!onMac)("the ownership boundary", () => {
  it("never lists or acts on a plist outside the label prefix, nor on an id that is not one of its plists", async () => {
    await put(join(agents, "com.example.other.plist"), "<plist/>");

    expect((await jobs.list()).jobs).toEqual([]);
    for (const id of ["../com.example.other", "other", "com.example.other"]) {
      await expect(jobs.delete({ id })).rejects.toThrow(/No job/);
      await expect(jobs.log({ id })).rejects.toThrow(/No job/);
    }
    expect(launchd.calls.filter(([verb]) => verb !== "print-disabled")).toEqual([]);
  });

  it("deletes a hand-written plist without touching files in the directory it names", async () => {
    const elsewhere = join(root, "elsewhere");
    await put(join(elsewhere, "logs", "by-hand.log"), "keep me\n");
    await put(
      plistPath("by-hand"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL_PREFIX}by-hand</string><key>ProgramArguments</key><array><string>/bin/echo</string></array><key>EnvironmentVariables</key><dict><key>${DIR_VARIABLE}</key><string>${elsewhere}</string></dict></dict></plist>\n`,
    );

    await jobs.delete({ id: "by-hand" });

    expect((await jobs.list()).jobs).toEqual([]);
    expect(await readFile(join(elsewhere, "logs", "by-hand.log"), "utf8")).toBe("keep me\n");
  });

  it("lists an unreadable plist under the prefix with its problem instead of failing the list", async () => {
    await put(plistPath("broken"), "not a plist");
    const [job] = (await jobs.list()).jobs;
    expect(job).toMatchObject({ id: "broken", managed: false, problem: expect.stringContaining("Could not read the plist") });
  });

  it("shows a hand-written plist as unmanaged, with its spawn line quoted", async () => {
    await put(
      plistPath("by-hand"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL_PREFIX}by-hand</string><key>ProgramArguments</key><array><string>/bin/echo</string><string>hello world</string></array></dict></plist>\n`,
    );
    const [job] = (await jobs.list()).jobs;
    expect(job).toMatchObject({ managed: false, adopted: false, command: "/bin/echo 'hello world'", schedule: { type: "none" } });
  });
});

describe("off macOS", () => {
  it("lists nothing and says so, and refuses every change", async () => {
    const linux = createJobs({ ownDir, launchAgentsDir: agents, platform: "linux", uid: 1000, run: launchd.run, envPath: undefined, warn: () => {} });
    expect(await linux.list()).toEqual({ supported: false, jobs: [], launchAgentsDir: agents });
    expect(await linux.health()).toEqual({ supported: false, jobCount: 0, failing: [] });
    await expect(linux.run({ id: "x" })).rejects.toThrow(/macOS/);
  });
});

describe("plist helpers", () => {
  it("takes a job's data directory from its plist, and the fallback when it names none", () => {
    expect(dataDirOf({ EnvironmentVariables: { [DIR_VARIABLE]: "/data/jobs/" } }, "/own")).toBe("/data/jobs");
    expect(dataDirOf({ EnvironmentVariables: { [DIR_VARIABLE]: "relative" } }, "/own")).toBe("/own");
    expect(dataDirOf(null, "/own")).toBe("/own");
  });

  it("calls a plist managed only when its runner is the one in the directory it names", () => {
    const args = ["/bin/zsh", "/data/jobs/runner.sh", "x", "echo hi"];
    expect(commandOf({ ProgramArguments: args }, "/data/jobs")).toEqual({ command: "echo hi", managed: true });
    expect(commandOf({ ProgramArguments: args }, "/elsewhere")).toEqual({ command: "/bin/zsh /data/jobs/runner.sh x 'echo hi'", managed: false });
  });
});

describe("readChunk", () => {
  it("answers whole lines, the line in progress apart, and where to read next", async () => {
    const path = join(root, "a.log");
    await put(path, "one\ntwo\nthr");

    const first = await readChunk(path, undefined, 1024);
    expect(first).toEqual({ text: "one\ntwo\n", pending: "thr", truncated: false, reset: false, next: 8 });

    await writeFile(path, "one\ntwo\nthree\nfour", "utf8");
    expect(await readChunk(path, first.next, 1024)).toEqual({ text: "three\n", pending: "four", truncated: false, reset: false, next: 14 });
  });

  it("starts a tail at its first whole line", async () => {
    const path = join(root, "b.log");
    await put(path, "aaaa\nbbbb\ncccc\n");
    expect(await readChunk(path, undefined, 8)).toMatchObject({ text: "cccc\n", truncated: true, next: 15 });
  });

  it("starts over when the file was rotated, or more arrived than one read carries", async () => {
    const path = join(root, "c.log");
    await put(path, "new\n");
    expect(await readChunk(path, 100, 1024)).toMatchObject({ text: "new\n", reset: true, next: 4 });
    await put(path, "x".repeat(50) + "\nlast\n");
    expect(await readChunk(path, 0, 8)).toMatchObject({ text: "last\n", reset: true, truncated: true });
  });

  it("reads a missing file as empty, and a reset when the caller had something", async () => {
    expect(await readChunk(join(root, "none.log"), undefined, 10)).toMatchObject({ text: "", reset: false, next: 0 });
    expect(await readChunk(join(root, "none.log"), 5, 10)).toMatchObject({ text: "", reset: true, next: 0 });
  });
});

describe("readRuns", () => {
  it("keeps the last twenty well-formed records, most recent first", async () => {
    const path = join(root, "runs.jsonl");
    const lines = Array.from({ length: 25 }, (_, index) => runLine(`2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`, index % 2));
    await put(path, lines.join("") + "not json\n");

    const runs = await readRuns(path);

    expect(runs).toHaveLength(20);
    expect(runs[0]?.startedAt).toBe("2026-01-25T00:00:00Z");
    expect(runs[19]?.startedAt).toBe("2026-01-06T00:00:00Z");
  });
});

describe.skipIf(!onMac)("the runner", () => {
  async function runRunner(dir: string, slug: string, command: string): Promise<number> {
    const runner = join(dir, "runner.sh");
    await put(runner, RUNNER_SCRIPT);
    try {
      await exec("/bin/zsh", [runner, slug, command], { env: { ...process.env, [DIR_VARIABLE]: dir } });
      return 0;
    } catch (error) {
      return (error as { code: number }).code;
    }
  }

  it("brackets the command's output in the log, and records the run", async () => {
    const dir = join(root, "runner");

    expect(await runRunner(dir, "hello", "echo out; echo err >&2; exit 3")).toBe(3);

    const log = await readFile(join(dir, "logs", "hello.log"), "utf8");
    expect(log).toMatch(/^=== \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ start\nout\nerr\n=== \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ exit 3\n$/);
    const [run] = await readRuns(join(dir, "runs", "hello.jsonl"));
    expect(run).toMatchObject({ exitCode: 3 });
  });

  it("rotates a log past a megabyte before the command starts", async () => {
    const dir = join(root, "rotate");
    await put(join(dir, "logs", "big.log"), "x".repeat(1_100_000));

    await runRunner(dir, "big", "echo fresh");

    expect((await stat(join(dir, "logs", "big.log.1"))).size).toBe(1_100_000);
    expect(await readFile(join(dir, "logs", "big.log"), "utf8")).toContain("fresh");
  });
});
