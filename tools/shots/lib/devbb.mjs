// A throwaway dev bb: its own data dir, ports and HOME, run from the launcher inside bb.app.
//
// Safety, every run:
// - The owner's bb (ports 38886/38887, ~/.bb) is never addressed: the dev bb gets a scrubbed
//   environment (no BB_* variables, no tokens or API keys) with BB_SERVER_URL pointing at its own port.
// - Only PIDs this module started are stopped: the launcher, and its descendants found by parent PID
//   (never by name). A listener left on a dev port is stopped only if its command line names this
//   run's data dir.
// - The root (data dir, fake HOME, logs) is removed on stop.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER_PORTS = [38886, 38887];
const CLAUDE_STUB = fileURLToPath(new URL("../claude-stub.mjs", import.meta.url));

export function devBbConfig(env = process.env) {
  // Keep the root short: the data dir holds Unix sockets.
  const root = resolve(env.SHOTS_ROOT ?? join(tmpdir(), "bbss"));
  const serverPort = Number(env.SHOTS_SERVER_PORT ?? 48896);
  const daemonPort = Number(env.SHOTS_DAEMON_PORT ?? 48897);
  const app = env.SHOTS_BB_APP ?? "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app";
  return {
    root,
    data: join(root, "data"),
    home: join(root, "home"),
    bin: join(root, "bin"),
    serverPort,
    daemonPort,
    url: `http://127.0.0.1:${serverPort}`,
    app,
    launcher: join(app, "dist", "bb-app.js"),
    cliEntry: join(app, "host-daemon", "dist", "bb"),
  };
}

/** Refuses a configuration that could reach the owner's bb or its data. */
export function assertIsolated(cfg) {
  for (const port of [cfg.serverPort, cfg.daemonPort]) {
    if (OWNER_PORTS.includes(port)) throw new Error(`port ${port} is the owner's bb; pick another (SHOTS_SERVER_PORT, SHOTS_DAEMON_PORT)`);
  }
  if (cfg.serverPort === cfg.daemonPort) throw new Error("the server and host daemon ports must differ");
  const realBb = join(homedir(), ".bb");
  const insideOrAbove = (dir) => cfg.root === dir || cfg.root.startsWith(dir + "/") || dir.startsWith(cfg.root + "/");
  if (insideOrAbove(realBb) || homedir().startsWith(cfg.root + "/") || cfg.root === homedir() || cfg.root.split("/").filter(Boolean).length < 2) {
    throw new Error(`refusing to use ${cfg.root} as the dev bb root: it is, holds or sits in the owner's home or bb data`);
  }
}

/** The file that marks a root as this harness's, so that nothing else is ever deleted as one. */
const ROOT_MARKER = ".bb-plugins-shots-root";

/** Deletes `root` if it is absent or marked as a harness root; refuses anything else. */
export function removeRoot(root) {
  if (!existsSync(root)) return;
  if (!existsSync(join(root, ROOT_MARKER))) {
    throw new Error(`${root} exists and is not a screenshot dev bb root (no ${ROOT_MARKER}); remove it yourself or pick another SHOTS_ROOT`);
  }
  rmSync(root, { recursive: true, force: true });
}

export function checkBbApp(cfg) {
  if (!existsSync(cfg.launcher) || !existsSync(cfg.cliEntry)) {
    throw new Error(
      `bb.app's launcher was not found at ${cfg.app}. Install bb (https://getbb.app) in /Applications, ` +
        "or point SHOTS_BB_APP at a bb-app package folder.",
    );
  }
  return JSON.parse(readFileSync(join(cfg.app, "package.json"), "utf8")).version;
}

/**
 * The dev bb's whole environment. Built from nothing rather than filtered, so no token, API key or
 * BB_* variable of the caller's reaches it. PATH is the system's plus a private `bin/` holding only
 * `node`, so the caller's own tool folders (where signed-in agent CLIs live) are not on it.
 */
export function devBbEnv(cfg, extra = {}) {
  return {
    HOME: cfg.home,
    USER: process.env.USER ?? "shots",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "shots",
    SHELL: "/bin/zsh",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "en_US.UTF-8",
    PATH: [cfg.bin, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"].join(":"),
    BB_TELEMETRY: "false",
    // Should anything still reach a real model provider, it reaches nothing.
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    OPENAI_BASE_URL: "http://127.0.0.1:9",
    ...extra,
  };
}

/** `bin/claude`: runs claude-stub.mjs (see there) with the dev bb's node. */
export function claudeShim(cfg) {
  return `#!/bin/sh\nexec "${join(cfg.bin, "node")}" "${CLAUDE_STUB}" "$@"\n`;
}

function portIsFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host: "127.0.0.1" }, () => server.close(() => done(true)));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every descendant of `pid`, by parent PID. */
export function descendantsOf(pid, table = processTable()) {
  const out = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [child, ppid] of table) {
      if (ppid === parent && !out.includes(child)) {
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

function processTable() {
  const text = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  return text
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
}

function commandLineOf(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function listenersOn(port) {
  try {
    return execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

export class DevBb {
  constructor(cfg = devBbConfig()) {
    assertIsolated(cfg);
    this.cfg = cfg;
    this.pid = null;
    this.started = false;
  }

  get pidFile() {
    return join(this.cfg.root, "pids.json");
  }

  /** Starts the dev bb and waits for its server and its local machine. */
  async start({ log = console.log } = {}) {
    const { cfg } = this;
    assertIsolated(cfg);
    const version = checkBbApp(cfg);
    if (existsSync(this.pidFile)) {
      const { launcher } = JSON.parse(readFileSync(this.pidFile, "utf8"));
      if (commandLineOf(launcher).includes(cfg.data)) {
        throw new Error(`a dev bb from an earlier run is still up (pid ${launcher}); stop it with \`npm run shots -- --stop\``);
      }
    }
    for (const port of [cfg.serverPort, cfg.daemonPort]) {
      if (!(await portIsFree(port))) throw new Error(`port ${port} is in use; stop whatever holds it or set SHOTS_SERVER_PORT / SHOTS_DAEMON_PORT`);
    }
    removeRoot(cfg.root);
    for (const dir of [cfg.data, cfg.home, cfg.bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(cfg.root, ROOT_MARKER), "A throwaway dev bb for tools/shots; deleted when the run ends.\n");
    symlinkSync(process.execPath, join(cfg.bin, "node"));
    writeFileSync(join(cfg.bin, "claude"), claudeShim(cfg), { mode: 0o755 });

    const out = openSync(join(cfg.root, "bb-app.log"), "a");
    const child = spawn(
      process.execPath,
      [cfg.launcher, "--data-dir", cfg.data, "--server-port", String(cfg.serverPort), "--host-daemon-port", String(cfg.daemonPort), "--no-in-app-updates", "--bundled"],
      { env: devBbEnv(cfg), stdio: ["ignore", out, out], cwd: cfg.home },
    );
    this.pid = child.pid;
    this.started = true;
    this.savePids();
    child.unref();
    log(`dev bb ${version} starting (pid ${this.pid}, ${cfg.url}, data ${cfg.data})`);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!pidAlive(this.pid)) throw new Error(`the dev bb exited during start; see ${join(cfg.root, "bb-app.log")}`);
      try {
        const res = await fetch(cfg.url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) break;
      } catch {}
      await sleep(300);
    }
    if (Date.now() >= deadline) throw new Error(`the dev bb did not answer on ${cfg.url} within 60 s; see ${join(cfg.root, "bb-app.log")}`);
    await this.waitFor("its machine to connect", () => {
      const machines = this.cliJson(["machine", "list", "--json"]);
      return machines.some((m) => m.status === "connected");
    });
    this.savePids();
    return version;
  }

  /** Records the launcher and its descendants, so a later `stop` (or `--stop`) finds them. */
  savePids() {
    if (!this.pid) return;
    let known = [];
    try {
      known = JSON.parse(readFileSync(this.pidFile, "utf8")).descendants ?? [];
    } catch {}
    const descendants = [...new Set([...known, ...descendantsOf(this.pid)])];
    writeFileSync(this.pidFile, JSON.stringify({ launcher: this.pid, descendants }));
  }

  /** Runs the bb CLI against the dev bb. Throws with its output on failure. */
  cli(args, { input } = {}) {
    const { cfg } = this;
    try {
      return execFileSync(process.execPath, [cfg.cliEntry, ...args], {
        env: devBbEnv(cfg, { BB_SERVER_URL: cfg.url, BB_HOST_DAEMON_PORT: String(cfg.daemonPort), BB_DATA_DIR: cfg.data }),
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`dev bb CLI failed: bb ${args.join(" ")}\n${error.stdout ?? ""}${error.stderr ?? ""}`.trim());
    }
  }

  cliJson(args) {
    return JSON.parse(this.cli(args));
  }

  async waitFor(what, test, { timeoutMs = 30_000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        if (await test()) return;
      } catch (error) {
        last = error;
      }
      await sleep(intervalMs);
    }
    throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}${last ? `: ${last.message}` : ""}`);
  }

  /**
   * Stops the PIDs this run started and removes the root. Safe to call more than once, and after a
   * start that failed or never happened (then it only removes a root a run left).
   */
  async stop({ log = console.log, keepRoot = false } = {}) {
    const { cfg } = this;
    assertIsolated(cfg); // never signal near, or delete, the owner's bb, whatever the config says
    let launcher = this.pid;
    let known = [];
    if (existsSync(this.pidFile)) {
      const saved = JSON.parse(readFileSync(this.pidFile, "utf8"));
      // A PID saved by an earlier run counts only while its command line still names our data dir:
      // after a reboot the number may belong to anything.
      if (!launcher && commandLineOf(saved.launcher).includes(cfg.data)) launcher = saved.launcher;
      known = saved.descendants ?? [];
    }
    if (launcher) {
      const children = descendantsOf(launcher);
      // A recorded descendant may have exited and its PID been reused; signal only what is still ours.
      const ours = [launcher, ...new Set([...children, ...known.filter((pid) => commandLineOf(pid).includes(cfg.root))])];
      for (const pid of ours) if (pidAlive(pid)) try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 40 && ours.some(pidAlive); i++) await sleep(250);
      for (const pid of ours) if (pidAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
      // A daemon that detached from the launcher: stop it only if its command line names our data dir.
      for (const port of [cfg.serverPort, cfg.daemonPort]) {
        for (const pid of listenersOn(port)) {
          if (commandLineOf(pid).includes(cfg.data)) {
            try { process.kill(pid, "SIGTERM"); } catch {}
          } else {
            log(`warning: port ${port} is held by pid ${pid}, which this run did not start; left alone`);
          }
        }
      }
    }
    if (!keepRoot) removeRoot(cfg.root);
    if (launcher) log(`dev bb stopped (pid ${launcher})${keepRoot ? "" : ` and ${cfg.root} removed`}`);
    this.pid = null;
  }
}
