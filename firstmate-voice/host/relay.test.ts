import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { answersAsServer, listLoopbackPorts, parseLsofPorts, RELAY_LOOKUP_MS, RelayFinder, type RelayDeps } from "./relay";
import { hookPath, runMachineHook } from "./run-hook";

const posix = process.platform !== "win32";
const realHome = process.env.HOME;
let servers: Server[] = [];
let dirs: string[] = [];

afterEach(async () => {
  process.env.HOME = realHome;
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A loopback server that answers every request with `answer`, and keeps the headers it was sent. */
async function serve(answer: { status: number; body: string; type?: string; delayMs?: number }): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    setTimeout(() => {
      res.writeHead(answer.status, { "content-type": answer.type ?? "application/json" });
      res.end(answer.body);
    }, answer.delayMs ?? 0);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, seen };
}

/** A daemon whose ports and answers the test sets; real timers, as `RelayFinder` would use. */
function fakeDaemon(state: { pid?: number; ports: number[] | Error; servers: number[] }) {
  const listed: number[] = [];
  const probed: number[] = [];
  const deps: RelayDeps = {
    daemonPid: () => state.pid ?? 4242,
    listPorts: async (pid) => {
      listed.push(pid);
      if (state.ports instanceof Error) throw state.ports;
      return state.ports;
    },
    answersAsServer: async (port) => {
      probed.push(port);
      return state.servers.includes(port);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  return { deps, listed, probed };
}

describe("reading lsof's answer", () => {
  it("keeps the 127.0.0.1 ports, each once, and nothing else", () => {
    const output = "p20390\nf16\nn127.0.0.1:57314\nf17\nn127.0.0.1:57316\nf20\nn127.0.0.1:48887\nf21\nn*:8080\nn[::1]:9000\nn127.0.0.1:57314\nn127.0.0.1:99999\n";
    expect(parseLsofPorts(output)).toEqual([57314, 57316, 48887]);
    expect(parseLsofPorts("")).toEqual([]);
  });

  it("refuses at once where there is no lsof", async () => {
    await expect(listLoopbackPorts(1234, "win32")).rejects.toThrow("no lsof on this machine (win32)");
  });

  it.runIf(existsSync("/usr/sbin/lsof") || existsSync("/usr/bin/lsof"))("lists a process's own loopback listening ports", async () => {
    const { port } = await serve({ status: 404, body: "" });
    await expect(listLoopbackPorts(process.pid)).resolves.toContain(port);
  });
});

describe("knowing bb's server on a port", () => {
  it("is an answer to /health of {ok: true} in JSON, as bb's own CLI checks", async () => {
    const server = await serve({ status: 200, body: JSON.stringify({ ok: true, launchId: "x" }) });
    await expect(answersAsServer(server.port)).resolves.toBe(true);
    // A plain request: no browser headers, which the relay refuses, and its own address as the Host.
    expect(server.seen[0]).not.toHaveProperty("origin");
    expect(server.seen[0]).not.toHaveProperty("sec-fetch-site");
    expect(server.seen[0]?.host).toBe(`127.0.0.1:${server.port}`);
  });

  it("is not the daemon's own API (plain ok), a 404, anything else, nothing listening or too slow", async () => {
    const localApi = await serve({ status: 200, body: "ok", type: "text/plain" });
    const broker = await serve({ status: 404, body: "" });
    const other = await serve({ status: 200, body: JSON.stringify({ ok: false }) });
    const slow = await serve({ status: 200, body: JSON.stringify({ ok: true }), delayMs: 2_000 });
    const closed = await serve({ status: 200, body: "" });
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const started = Date.now();
    const answers = await Promise.all([localApi, broker, other, closed].map(({ port }) => answersAsServer(port)));
    expect(answers).toEqual([false, false, false, false]);
    await expect(answersAsServer(slow.port, 100)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("finding bb's relay for a hook", () => {
  it("is the one daemon port that answers as bb's server", async () => {
    const daemon = fakeDaemon({ ports: [48887, 57314, 57316], servers: [57314] });
    await expect(new RelayFinder(daemon.deps).forRun(true)).resolves.toEqual({ url: "http://127.0.0.1:57314", note: null });
    expect(daemon.listed).toEqual([4242]);
    expect(daemon.probed.sort()).toEqual([48887, 57314, 57316]);
  });

  it("is checked, not looked for again, by the session's later hooks, and looked for afresh when its port goes", async () => {
    const state = { ports: [48887, 57314] as number[] | Error, servers: [57314] };
    const daemon = fakeDaemon(state);
    const finder = new RelayFinder(daemon.deps);
    await finder.forRun(true);
    daemon.probed.length = 0;
    await expect(finder.forRun(false)).resolves.toEqual({ url: "http://127.0.0.1:57314", note: null });
    expect(daemon.probed).toEqual([]);
    // The next session looks afresh.
    await finder.forRun(true);
    expect(daemon.probed.sort()).toEqual([48887, 57314]);
    // The daemon now listens elsewhere: a later hook looks again rather than use a stale port.
    state.ports = [48887, 60001];
    state.servers = [60001];
    daemon.probed.length = 0;
    await expect(finder.forRun(false)).resolves.toEqual({ url: "http://127.0.0.1:60001", note: null });
    expect(daemon.probed.sort()).toEqual([48887, 60001]);
  });

  it("sets nothing, and says why, where there is no relay (the machine running bb's server)", async () => {
    const finder = new RelayFinder(fakeDaemon({ ports: [48887, 57316], servers: [] }).deps);
    const found = await finder.forRun(true);
    expect(found.url).toBeNull();
    expect(found.note).toMatch(/^no bb relay on this machine/);
  });

  it("sets nothing when more than one port answers, when lsof fails, or when the daemon is gone", async () => {
    await expect(new RelayFinder(fakeDaemon({ ports: [1001, 1002], servers: [1001, 1002] }).deps).forRun(true)).resolves.toEqual({
      url: null,
      note: "more than one of bb's host daemon's loopback ports answers as bb's server (1001, 1002), so none is used",
    });
    await expect(new RelayFinder(fakeDaemon({ ports: new Error("lsof did not answer within 1 s"), servers: [] }).deps).forRun(true)).resolves.toEqual({
      url: null,
      note: "could not list bb's host daemon's ports: lsof did not answer within 1 s",
    });
    const orphan = fakeDaemon({ pid: 1, ports: [57314], servers: [57314] });
    await expect(new RelayFinder(orphan.deps).forRun(true)).resolves.toEqual({ url: null, note: "bb's host daemon is gone" });
    expect(orphan.listed).toEqual([]);
  });

  it("forgets a relay its daemon no longer lists, and one whose lookup failed", async () => {
    const state = { ports: [57314] as number[] | Error, servers: [57314] };
    const finder = new RelayFinder(fakeDaemon(state).deps);
    await finder.forRun(true);
    state.ports = new Error("lsof failed");
    expect((await finder.forRun(false)).url).toBeNull();
    state.ports = [57314];
    state.servers = [];
    expect((await finder.forRun(false)).url).toBeNull();
  });

  it(`gives up after ${RELAY_LOOKUP_MS} ms, so the hook is never held longer`, async () => {
    const daemon = fakeDaemon({ ports: [57314], servers: [57314] });
    daemon.deps.listPorts = () => new Promise(() => undefined);
    const started = Date.now();
    await expect(new RelayFinder(daemon.deps).forRun(true)).resolves.toEqual({ url: null, note: "looking for bb's relay took longer than 1.5 s" });
    expect(Date.now() - started).toBeLessThan(RELAY_LOOKUP_MS + 1_000);
  });
});

describe.runIf(posix)("a hook run through the host entry", () => {
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "fmv-relay-"));
    dirs.push(dir);
    process.env.HOME = dir;
    return dir;
  }

  function hook(dir: string, out: string): void {
    const file = hookPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\nprintf '%s' "\${BB_SERVER_URL-unset}" > '${out}'\n`);
    chmodSync(file, 0o755);
  }

  it("gets the relay as BB_SERVER_URL, looked for afresh at listening-started only", async () => {
    const dir = home();
    const out = join(dir, "out");
    hook(dir, out);
    const daemon = fakeDaemon({ ports: [57314], servers: [57314] });
    const finder = new RelayFinder(daemon.deps);
    await expect(runMachineHook("listening-started", null, finder)).resolves.toMatchObject({ exitCode: 0, bbServerUrl: "http://127.0.0.1:57314", relayNote: null });
    expect(readFileSync(out, "utf8")).toBe("http://127.0.0.1:57314");
    daemon.probed.length = 0;
    await runMachineHook("speaking-started", null, finder);
    expect(readFileSync(out, "utf8")).toBe("http://127.0.0.1:57314");
    expect(daemon.probed).toEqual([]);
  });

  it("runs as it always has, and says why, when there is no relay", async () => {
    const dir = home();
    const out = join(dir, "out");
    hook(dir, out);
    const finder = new RelayFinder(fakeDaemon({ ports: new Error("no lsof on this machine (linux)"), servers: [] }).deps);
    await expect(runMachineHook("listening-started", null, finder)).resolves.toMatchObject({
      exitCode: 0,
      bbServerUrl: null,
      relayNote: "could not list bb's host daemon's ports: no lsof on this machine (linux)",
    });
    // The environment is the worker's own, untouched (a bb host worker has no BB_* variable; this test's may).
    expect(readFileSync(out, "utf8")).toBe(process.env.BB_SERVER_URL ?? "unset");
  });

  it("looks for nothing when there is no hook file", async () => {
    home();
    const daemon = fakeDaemon({ ports: [57314], servers: [57314] });
    await expect(runMachineHook("listening-started", null, new RelayFinder(daemon.deps))).resolves.toBeNull();
    expect(daemon.listed).toEqual([]);
  });
});
