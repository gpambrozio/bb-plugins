/**
 * bb's relay on this machine, so a voice hook can call `bb` (`bb herald mute`, say) on a machine that joined
 * bb through bb Connect. **This is bb internals, not SDK**, read from bb 0.49.0's host daemon, and a bb update
 * may stop it working; every way it can fail leaves the hook running as it would without it.
 *
 * - **What the relay is.** On a machine joined through Connect, bb's host daemon listens on a loopback port of
 *   its own (a new one each time it starts) and forwards every request there to the bb server, adding the
 *   machine's Connect credential. bb's terminals and threads get it as `BB_SERVER_URL`; a plugin's host worker
 *   gets no `BB_*` variable at all. Without it `bb` tries 127.0.0.1:38886, which on such a machine is nothing.
 * - **How it is found.** This worker's parent is the host daemon. `lsof` lists the loopback ports the daemon
 *   listens on (its local API, a browser broker, and on a Connect machine the relay), and the relay is the one
 *   that answers `GET /health` as bb's server does (`{"ok":true,…}`), the check bb's own CLI makes. The
 *   daemon's local API answers `ok` as plain text, the broker 404. Exactly one port must answer.
 * - **When.** A session's first hook (`listening-started`) looks afresh; the others reuse what it found while
 *   the same daemon still listens on that port, which takes one `lsof` and no request through the relay. The
 *   relay's port is fixed for the daemon's life, and a daemon that restarts starts new workers.
 * - **The machine running bb's server** has no relay: nothing answers, nothing is set, and `bb` there reaches
 *   the server at its default address, as it does today.
 * - **Only the URL.** The credential stays in the daemon: nothing here reads the daemon's environment, and
 *   the hook gets `BB_SERVER_URL=http://127.0.0.1:<port>` and nothing more. A hook that calls `bb` with it has
 *   the owner's full bb access, as any program on the machine that finds that port already has.
 * - **Never in the hook's way.** The lookup gives up after `RELAY_LOOKUP_MS`; then, or on any failure, the
 *   hook runs without `BB_SERVER_URL`, and the run says why for the debug log.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";

/** The longest a hook waits for the lookup before it runs without `BB_SERVER_URL`. */
export const RELAY_LOOKUP_MS = 1_500;
/** How long `lsof` may take. */
export const LSOF_TIMEOUT_MS = 1_000;
/** How long one port may take to answer `/health`. */
export const PROBE_TIMEOUT_MS = 500;
/** The most of a `/health` answer read. */
const PROBE_MAX_BYTES = 4_096;

/** What a hook run gets: the relay's URL, or none and why. */
export type RelayLookup = { url: string; note: null } | { url: null; note: string };

export interface RelayDeps {
  /** The host daemon's process id: this worker's parent. */
  daemonPid(): number;
  /** The loopback TCP ports `pid` listens on; rejects with why when it cannot tell. */
  listPorts(pid: number): Promise<number[]>;
  /** Whether the loopback `port` answers `/health` as bb's server does. Never rejects. */
  answersAsServer(port: number): Promise<boolean>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function relayUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The 127.0.0.1 ports in `lsof -Fn` output (`n127.0.0.1:57314` lines), each once. */
export function parseLsofPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    const match = /^n127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
    if (match === null) continue;
    const port = Number(match[1]);
    if (port > 0 && port < 65_536) ports.add(port);
  }
  return [...ports];
}

const LSOF_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["/usr/sbin/lsof"],
  linux: ["/usr/bin/lsof", "/usr/sbin/lsof", "/bin/lsof"],
};

/**
 * The loopback ports `pid` listens on, from `lsof`. `-b` keeps lsof off the calls that can block (a stat of
 * an unreachable mount hung it for minutes here), `-w` drops the warnings that come with it.
 */
export function listLoopbackPorts(pid: number, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  const lsof = (LSOF_PATHS[platform] ?? []).find((path) => existsSync(path));
  if (lsof === undefined) return Promise.reject(new Error(`no lsof on this machine (${platform})`));
  return new Promise((resolve, reject) => {
    execFile(
      lsof,
      ["-b", "-w", "-n", "-P", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      { timeout: LSOF_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        // lsof exits 1 when nothing matches: no port at all.
        if (error === null || (error.code === 1 && error.killed !== true && stdout.trim() === "")) return resolve(parseLsofPorts(stdout));
        reject(new Error(error.killed === true ? `lsof did not answer within ${LSOF_TIMEOUT_MS / 1000} s` : `lsof failed: ${error.message}`));
      },
    );
  });
}

/**
 * Whether `port` on 127.0.0.1 answers `GET /health` with bb's server's `{"ok":true,…}`. A plain request: the
 * relay refuses one that carries a browser's `Origin` or `Sec-Fetch-Site`, and wants `Host` to be itself.
 */
export function answersAsServer(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET", agent: false, headers: { accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) return finish(false);
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > PROBE_MAX_BYTES) finish(false);
      });
      res.on("end", () => {
        try {
          const answer: unknown = JSON.parse(body);
          finish(typeof answer === "object" && answer !== null && (answer as { ok?: unknown }).ok === true);
        } catch {
          finish(false);
        }
      });
      res.on("error", () => finish(false));
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    req.on("error", () => finish(false));
    req.end();
  });
}

export const realRelayDeps: RelayDeps = {
  daemonPid: () => process.ppid,
  listPorts: (pid) => listLoopbackPorts(pid),
  answersAsServer: (port) => answersAsServer(port),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function none(note: string): RelayLookup {
  return { url: null, note };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Finds the relay, and remembers it for the session's later hooks. */
export class RelayFinder {
  /** What the last lookup found, and under which daemon. */
  private found: { pid: number; port: number } | null = null;

  constructor(private readonly deps: RelayDeps = realRelayDeps) {}

  /** The relay for one hook run: looked up afresh at a session's start, checked again otherwise. Never rejects. */
  async forRun(fresh: boolean): Promise<RelayLookup> {
    let timer: unknown = null;
    const deadline = new Promise<RelayLookup>((resolve) => {
      timer = this.deps.setTimeout(() => resolve(none(`looking for bb's relay took longer than ${RELAY_LOOKUP_MS / 1000} s`)), RELAY_LOOKUP_MS);
    });
    try {
      return await Promise.race([this.lookup(fresh).catch((error: unknown) => none(`looking for bb's relay failed: ${errorText(error)}`)), deadline]);
    } finally {
      this.deps.clearTimeout(timer);
    }
  }

  private async lookup(fresh: boolean): Promise<RelayLookup> {
    const pid = this.deps.daemonPid();
    // An orphaned worker's parent is launchd or init, whose ports are no business of a hook.
    if (!Number.isInteger(pid) || pid <= 1) {
      this.found = null;
      return none("bb's host daemon is gone");
    }
    let ports: number[];
    try {
      ports = await this.deps.listPorts(pid);
    } catch (error) {
      this.found = null;
      return none(`could not list bb's host daemon's ports: ${errorText(error)}`);
    }
    const known = this.found;
    if (!fresh && known !== null && known.pid === pid && ports.includes(known.port)) return { url: relayUrl(known.port), note: null };
    this.found = null;
    const answers = await Promise.all(ports.map((port) => this.deps.answersAsServer(port).catch(() => false)));
    const servers = ports.filter((_, index) => answers[index]);
    if (servers.length === 0) {
      return none("no bb relay on this machine (none of bb's host daemon's loopback ports answers as bb's server), so bb's default address applies, as on the machine running bb's server");
    }
    if (servers.length > 1) return none(`more than one of bb's host daemon's loopback ports answers as bb's server (${servers.join(", ")}), so none is used`);
    this.found = { pid, port: servers[0]! };
    return { url: relayUrl(servers[0]!), note: null };
  }
}
