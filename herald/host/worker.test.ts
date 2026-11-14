/**
 * Herald's built host entry in bb's real host worker (`plugin-host-worker`),
 * driven over its IPC protocol the way the host daemon drives it: calls, then
 * `dispose`. bb gives a worker 5 s to dispose, then exits it, and the daemon
 * SIGKILLs it about then; these check that a shutdown during a run of speech
 * still runs the after hook, reports it, and leaves no hook process behind.
 *
 * It needs the built artifact (`dist/host.js`, from `bb plugin build`, which
 * CI runs before the tests) and a bb install to take the worker from: the
 * desktop app, the global `bb-app` package CI installs, or `BB_HOST_WORKER`.
 * Without either it is skipped; with a `dist/host.js` older than the host
 * sources it fails, rather than test old code.
 */
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifact = join(root, "dist", "host.js");
const WORKER_FILES = ["bb-plugin-host-worker.mjs", "plugin-host-worker.js"];

function workerPath(): string | null {
  if (process.env.BB_HOST_WORKER !== undefined) return process.env.BB_HOST_WORKER;
  const dirs = ["/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist"];
  try {
    const global = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirs.push(join(global, "bb-app", "host-daemon", "dist"));
  } catch {
    // No npm on PATH: only the desktop app's worker is looked for.
  }
  for (const dir of dirs) for (const file of WORKER_FILES) if (existsSync(join(dir, file))) return join(dir, file);
  return null;
}

const worker = workerPath();
const runnable = process.platform !== "win32" && worker !== null && existsSync(artifact);

function newestSource(): number {
  const files = ["host.ts", ...["host", "shared"].flatMap((dir) => readdir(join(root, dir)))];
  return Math.max(...files.map((file) => statSync(join(root, file)).mtimeMs));
}

function readdir(dir: string): string[] {
  return execFileSync("ls", [dir], { encoding: "utf8" })
    .split("\n")
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir.slice(root.length + 1), name));
}

interface Worker {
  child: ChildProcess;
  messages: Array<Record<string, unknown>>;
  stderr: () => string;
  call(method: string, input: unknown): Promise<Record<string, unknown>>;
  exited: Promise<{ code: number | null; signal: string | null; afterMs: number }>;
  dispose(): number;
}

let dirs: string[] = [];
let children: ChildProcess[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "herald-worker-"));
  dirs.push(dir);
  return dir;
}

async function startWorker(): Promise<Worker> {
  const dir = scratch();
  const child = fork(worker as string, [artifact, "herald", "test-generation", join(dir, "data"), join(dir, "tmp")], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const messages: Array<Record<string, unknown>> = [];
  const waiting = new Map<string, (message: Record<string, unknown>) => void>();
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => (ready = resolve));
  child.on("message", (raw) => {
    const message = raw as Record<string, unknown>;
    messages.push(message);
    if (message.type === "ready") ready();
    if (message.type === "result") waiting.get(message.callId as string)?.(message);
  });
  let disposedAt = 0;
  const exited = new Promise<{ code: number | null; signal: string | null; afterMs: number }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, afterMs: Date.now() - disposedAt })),
  );
  await isReady;
  let next = 0;
  return {
    child,
    messages,
    stderr: () => stderr,
    exited,
    call: (method, input) =>
      new Promise((resolve) => {
        const callId = String((next += 1));
        waiting.set(callId, resolve);
        child.send({ type: "call", callId, method, input, envVars: {} });
      }),
    dispose: () => {
      disposedAt = Date.now();
      child.send({ type: "dispose" });
      return disposedAt;
    },
  };
}

async function waitForFile(path: string): Promise<string> {
  for (let i = 0; i < 100 && !existsSync(path); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return readFileSync(path, "utf8").trim();
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signals(worker: Worker): Array<Record<string, unknown>> {
  return worker.messages.filter((message) => message.type === "signal").map((message) => message.payload as Record<string, unknown>);
}

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  children = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe.runIf(runnable)("Herald's host entry in bb's real host worker", () => {
  it("is built from the current sources", () => {
    expect(statSync(artifact).mtimeMs, "dist/host.js is older than the host sources: run `bb plugin build`").toBeGreaterThanOrEqual(
      newestSource(),
    );
  });

  it("cuts a running before hook short on shutdown, runs the after hook, reports it and exits inside bb's budget", async () => {
    const dir = scratch();
    const w = await startWorker();
    void w.call("begin", {
      runId: "r1",
      before: `echo $$ > '${join(dir, "before.pid")}'; sleep 30`,
      after: `echo after >> '${join(dir, "log")}'`,
      leaseMs: 30_000,
    });
    const beforePid = Number(await waitForFile(join(dir, "before.pid")));
    w.dispose();
    const exit = await w.exited;
    expect(exit.code).toBe(0);
    expect(exit.afterMs).toBeLessThan(4_500);
    expect(readFileSync(join(dir, "log"), "utf8")).toBe("after\n");
    expect(groupAlive(beforePid)).toBe(false);
    expect(w.stderr()).toMatch(/Herald's host worker shut down during a run of speech or its after hook; the after-speaking hook ran\./);
    expect(signals(w)).toMatchObject([{ reason: "disposed", runIds: ["r1"], after: { exitCode: 0 } }]);
  }, 20_000);

  it("reports an after hook that fails on shutdown, with its exit code and error output", async () => {
    const w = await startWorker();
    await w.call("begin", { runId: "r1", before: "true", after: "echo disposal-hook-failed >&2; exit 4", leaseMs: 30_000 });
    w.dispose();
    const exit = await w.exited;
    expect(exit.code).toBe(0);
    expect(w.stderr()).toContain("the after-speaking hook failed: it exited with 4: disposal-hook-failed");
    expect(signals(w)).toMatchObject([{ reason: "disposed", after: { exitCode: 4, stderr: "disposal-hook-failed\n" } }]);
  }, 20_000);

  it("kills an after hook that outlasts the shutdown budget, with what it started, and still exits in time", async () => {
    const dir = scratch();
    const w = await startWorker();
    await w.call("begin", {
      runId: "r1",
      before: "",
      after: `echo $$ > '${join(dir, "after.pid")}'; sleep 30 & sleep 30`,
      leaseMs: 30_000,
    });
    w.dispose();
    const afterPid = Number(await waitForFile(join(dir, "after.pid")));
    const exit = await w.exited;
    expect(exit.code).toBe(0);
    expect(exit.afterMs).toBeLessThan(4_500);
    expect(groupAlive(afterPid)).toBe(false);
    expect(w.stderr()).toContain("the after-speaking hook failed");
  }, 20_000);

  it("reports, without running it again, a failing after hook a window's end started when a shutdown comes", async () => {
    const dir = scratch();
    const w = await startWorker();
    await w.call("begin", {
      runId: "r1",
      before: "",
      after: `echo after >> '${join(dir, "log")}'; echo $$ > '${join(dir, "after.pid")}'; sleep 1; echo restore-failed >&2; exit 5`,
      leaseMs: 30_000,
    });
    void w.call("end", { runId: "r1" });
    await waitForFile(join(dir, "after.pid"));
    w.dispose();
    const exit = await w.exited;
    expect(exit.code).toBe(0);
    expect(exit.afterMs).toBeLessThan(4_500);
    expect(readFileSync(join(dir, "log"), "utf8")).toBe("after\n");
    expect(w.stderr()).toContain("the after-speaking hook failed: it exited with 5: restore-failed");
    expect(signals(w)).toMatchObject([{ reason: "disposed", runIds: ["r1"], after: { exitCode: 5 } }]);
  }, 20_000);

  it("reports an after hook a window's end started that the shutdown has to cut short", async () => {
    const dir = scratch();
    const w = await startWorker();
    await w.call("begin", { runId: "r1", before: "", after: `echo $$ > '${join(dir, "after.pid")}'; sleep 30`, leaseMs: 30_000 });
    void w.call("end", { runId: "r1" });
    const afterPid = Number(await waitForFile(join(dir, "after.pid")));
    w.dispose();
    const exit = await w.exited;
    expect(exit.code).toBe(0);
    expect(exit.afterMs).toBeLessThan(4_500);
    expect(groupAlive(afterPid)).toBe(false);
    expect(w.stderr()).toContain("the after-speaking hook failed: it was ended by SIGKILL");
    expect(signals(w)).toMatchObject([{ reason: "disposed", runIds: ["r1"], after: { signal: "SIGKILL" } }]);
  }, 20_000);
});
