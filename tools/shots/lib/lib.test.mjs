// Unit tests for the harness's pure parts. Run with `npm test` in tools/shots; nothing here starts bb
// or a browser.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SEND_ROUTES } from "./browser.mjs";
import { assertIsolated, assertStubsFirst, claudeShim, descendantsOf, devBbConfig, devBbEnv, launchctlShim, removeRoot, shellProfile } from "./devbb.mjs";
import { findChromium, videoBrowsersPath } from "./prereqs.mjs";
import { denyList, findPrivate } from "./privacy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "shots-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("devbb", () => {
  test("refuses the owner's ports and data", () => {
    assert.throws(() => assertIsolated(devBbConfig({ SHOTS_SERVER_PORT: "38886" })), /owner's bb/);
    assert.throws(() => assertIsolated(devBbConfig({ SHOTS_DAEMON_PORT: "38887" })), /owner's bb/);
    assert.throws(() => assertIsolated(devBbConfig({ SHOTS_ROOT: join(homedir(), ".bb", "x") })), /owner's home or bb data/);
    assert.throws(() => assertIsolated(devBbConfig({ SHOTS_ROOT: homedir() })), /owner's home or bb data/);
    assert.throws(() => assertIsolated(devBbConfig({ SHOTS_ROOT: dirname(homedir()) })), /owner's home or bb data/);
    assert.throws(() => assertIsolated(devBbConfig({ SHOTS_ROOT: "/tmp" })), /owner's home or bb data/);
    assert.throws(() => assertIsolated(devBbConfig({ SHOTS_SERVER_PORT: "48896", SHOTS_DAEMON_PORT: "48896" })), /must differ/);
    assert.doesNotThrow(() => assertIsolated(devBbConfig({ SHOTS_ROOT: join(scratch, "bbss") })));
  });

  test("removes only a root the harness marked", () => {
    const foreign = join(scratch, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.txt"), "");
    assert.throws(() => removeRoot(foreign), /not a screenshot dev bb root/);
    assert.ok(existsSync(join(foreign, "keep.txt")));
    const ours = join(scratch, "ours");
    mkdirSync(ours);
    writeFileSync(join(ours, ".bb-plugins-shots-root"), "");
    removeRoot(ours);
    assert.ok(!existsSync(ours));
    assert.doesNotThrow(() => removeRoot(join(scratch, "absent")));
  });

  test("the dev bb's environment carries none of the caller's variables", () => {
    const cfg = devBbConfig({ SHOTS_ROOT: join(scratch, "bbss") });
    const env = devBbEnv(cfg);
    assert.equal(env.HOME, cfg.home);
    assert.ok(!Object.keys(env).some((key) => key.startsWith("BB_") && key !== "BB_TELEMETRY"));
    assert.ok(!Object.keys(env).some((key) => /TOKEN|API_KEY/.test(key)));
    assert.ok(env.PATH.startsWith(`${cfg.bin}:`));
    assert.ok(!env.PATH.includes(homedir()));
  });

  test("descendants are found by parent PID, transitively", () => {
    const table = [
      [10, 1],
      [11, 10],
      [12, 11],
      [13, 10],
      [20, 1],
    ];
    assert.deepEqual(descendantsOf(10, table).sort(), [11, 12, 13]);
    assert.deepEqual(descendantsOf(20, table), []);
  });
});

describe("the send guard", () => {
  const sends = [
    "http://127.0.0.1:48896/api/v1/threads",
    "http://127.0.0.1:48896/api/v1/threads?x=1",
    "http://127.0.0.1:48896/api/v1/threads/thr_1/send",
    "http://127.0.0.1:48896/api/v1/threads/thr_1/edit-message",
    "http://127.0.0.1:48896/api/v1/threads/thr_1/retry",
    "http://127.0.0.1:48896/api/v1/threads/thr_1/queued-messages",
    "http://127.0.0.1:48896/api/v1/threads/thr_1/queued-messages/q_1/send",
    "http://127.0.0.1:48896/api/v1/threads/fork",
  ];
  const others = [
    "http://127.0.0.1:48896/api/v1/threads/thr_1/timeline",
    "http://127.0.0.1:48896/api/v1/threads/thr_1/read",
    "http://127.0.0.1:48896/api/v1/threads/search",
    "http://127.0.0.1:48896/api/v1/projects",
  ];
  for (const url of sends) test(`matches ${new URL(url).pathname}`, () => assert.match(url, SEND_ROUTES));
  for (const url of others) test(`leaves ${new URL(url).pathname}`, () => assert.doesNotMatch(url, SEND_ROUTES));
});

describe("prerequisites", () => {
  const binary = process.platform === "darwin" ? `chrome-headless-shell-mac-${process.arch}/chrome-headless-shell` : null;
  const fakeShell = (cache, revision) => {
    const path = join(cache, `chromium_headless_shell-${revision}`, binary);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    return path;
  };

  test("prefers the expected Chromium revision, then the newest cached", { skip: !binary }, () => {
    const cache = join(scratch, "pw1");
    fakeShell(cache, 1200);
    const newest = fakeShell(cache, 1230);
    assert.equal(findChromium({ env: {}, cache, expected: { "chromium-headless-shell": "1250" } }).executablePath, newest);
    const exact = fakeShell(cache, 1210);
    assert.equal(findChromium({ env: {}, cache, expected: { "chromium-headless-shell": "1210" } }).executablePath, exact);
  });

  test("says what to do when no Chromium is cached", () => {
    assert.throws(() => findChromium({ env: {}, cache: join(scratch, "empty"), expected: { "chromium-headless-shell": "1" } }), /playwright-core install/);
  });

  test("links the system ffmpeg only when Playwright's is missing", () => {
    const cache = join(scratch, "pw2");
    const root = join(scratch, "root");
    const name = process.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux";
    const dir = videoBrowsersPath({ root, env: {}, cache, expected: { ffmpeg: "1011" }, ffmpeg: "/bin/echo" });
    assert.equal(dir, join(root, "pw-browsers"));
    mkdirSync(join(cache, "ffmpeg-1011"), { recursive: true });
    writeFileSync(join(cache, "ffmpeg-1011", name), "");
    assert.equal(videoBrowsersPath({ root, env: {}, cache, expected: { ffmpeg: "1011" }, ffmpeg: "/bin/echo" }), null);
  });
});

describe("privacy", () => {
  test("finds deny-list terms case-insensitively", () => {
    assert.deepEqual(findPrivate("Path: /Users/someone/x on STUDIO-MAC", ["/Users/", "studio-mac", "nope"]), ["/Users/", "studio-mac"]);
  });

  test("the deny list has the home folder and SHOTS_DENY, and no short terms", () => {
    const terms = denyList({ SHOTS_DENY: "Real Project, ab" });
    assert.ok(terms.includes(homedir()));
    assert.ok(terms.includes("/Users/"));
    assert.ok(terms.includes("Real Project"));
    assert.ok(terms.every((term) => term.length >= 3));
  });
});

describe("the claude stub", () => {
  const stub = join(HERE, "..", "claude-stub.mjs");
  const replies = join(scratch, "claude-print.json");
  writeFileSync(replies, JSON.stringify([{ match: "login", reply: { summary: "Login is fixed.", speak: true } }, { match: "plain", reply: "A plain answer." }]));
  const run = (args, input = "", env = {}) =>
    spawnSync(process.execPath, [stub, ...args], { input, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

  test("answers --version", () => {
    const result = run(["--version"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\(Claude Code\)/);
  });

  test("answers initialize with models", () => {
    const request = { type: "control_request", request_id: "r1", request: { subtype: "initialize" } };
    const result = run(["--input-format", "stream-json"], JSON.stringify(request) + "\n");
    const reply = JSON.parse(result.stdout.trim());
    assert.equal(reply.response.request_id, "r1");
    assert.ok(reply.response.response.models.length > 0);
  });

  test("refuses a user turn and a plain prompt", () => {
    const turn = { type: "user", message: { role: "user", content: "hello" } };
    assert.equal(run(["--input-format", "stream-json"], JSON.stringify(turn) + "\n").status, 1);
    assert.equal(run(["-p", "hello"]).status, 1);
    const request = { type: "control_request", request_id: "r2", request: { subtype: "initialize" } };
    const session = run(["-p", "--input-format", "stream-json"], JSON.stringify(request) + "\n", { SHOTS_CLAUDE_PRINT: replies });
    assert.equal(JSON.parse(session.stdout.trim()).response.request_id, "r2");
    assert.equal(run(["-p"], "no reply matches this", { SHOTS_CLAUDE_PRINT: replies }).status, 1);
  });

  test("answers a -p prompt from its canned replies, as Claude Code's JSON result or as text", () => {
    const json = run(["-p", "--tools", "", "--output-format", "json", "--json-schema", "{}"], "Thread: Fix login", { SHOTS_CLAUDE_PRINT: replies });
    assert.equal(json.status, 0);
    const result = JSON.parse(json.stdout);
    assert.equal(result.is_error, false);
    assert.deepEqual(result.structured_output, { summary: "Login is fixed.", speak: true });
    const text = run(["-p"], "a plain one", { SHOTS_CLAUDE_PRINT: replies });
    assert.equal(text.stdout.trim(), "A plain answer.");
  });
});

describe("the launchctl stub", () => {
  const stub = join(HERE, "..", "launchctl-stub.mjs");
  const state = join(scratch, "launchd.json");
  const log = join(scratch, "launchctl.log");
  const domain = `gui/${process.getuid()}`;
  const run = (...args) =>
    spawnSync(process.execPath, [stub, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, SHOTS_LAUNCHD: state, SHOTS_LAUNCHCTL_LOG: log } });

  test("refuses to run without its state file's name", () => {
    const result = spawnSync(process.execPath, [stub, "print-disabled", domain], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(result.status, 1);
  });

  test("keeps a launchd of its own: print, bootstrap, kickstart, disable, bootout", () => {
    writeFileSync(state, JSON.stringify({ services: { "demo.running": { running: true, pid: 42, runs: 3, lastExitCode: 0 } }, disabled: [] }));
    const running = run("print", `${domain}/demo.running`);
    assert.equal(running.status, 0);
    assert.match(running.stdout, /^\s*state = running$/m);
    assert.match(running.stdout, /^\s*pid = 42$/m);
    assert.match(running.stdout, /^\s*last exit code = 0$/m);

    const missing = run("print", `${domain}/demo.new`);
    assert.equal(missing.status, 113);
    assert.match(missing.stderr, /Could not find service/);

    assert.equal(run("bootstrap", domain, "/x/demo.new.plist").status, 0);
    assert.equal(run("bootstrap", domain, "/x/demo.new.plist").status, 5);
    assert.equal(run("kickstart", `${domain}/demo.new`).status, 0);
    assert.match(run("print", `${domain}/demo.new`).stdout, /^\s*runs = 1$/m);
    assert.equal(run("bootout", `${domain}/demo.new`).status, 0);
    assert.equal(run("bootout", `${domain}/demo.new`).status, 3);
    assert.equal(run("disable", `${domain}/demo.new`).status, 0);
    assert.match(run("print-disabled", domain).stdout, /"demo\.new" => disabled/);
    assert.equal(run("bootstrap", domain, "/x/demo.new.plist").status, 119);
    assert.equal(run("enable", `${domain}/demo.new`).status, 0);
    assert.doesNotMatch(run("print-disabled", domain).stdout, /demo\.new/);
  });

  test("fails anything else and records every call", () => {
    assert.equal(run("load", "-w", "/x/demo.plist").status, 1);
    assert.equal(run("print", "system/demo").status, 64);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.at(-2), ["load", "-w", "/x/demo.plist"]);
  });
});

describe("the scripted ACP agent", () => {
  const agent = join(HERE, "..", "scripted-acp-agent.mjs");
  const script = join(scratch, "script.json");
  writeFileSync(
    script,
    JSON.stringify([
      { match: "upgrade", reply: "Needs an install.", permission: { title: "npm install", command: "npm install" } },
      { match: "nightly", reply: "Running.", error: "Out of memory." },
    ]),
  );

  /** Runs one prompt; `answer` replies to the agent's own requests. Resolves with every message. */
  function prompt(text, answer = () => undefined) {
    const child = spawn(process.execPath, [agent], { env: { PATH: process.env.PATH, SHOTS_SCRIPT: script } });
    const messages = [];
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    return new Promise((resolve) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.method && message.id !== undefined) send({ id: message.id, result: answer(message) });
        if (message.id === 3) {
          child.kill();
          resolve(messages);
        }
      });
      send({ id: 1, method: "initialize", params: {} });
      send({ id: 2, method: "session/new", params: {} });
      send({ id: 3, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text }] } });
    });
  }

  test("asks for a permission and waits for the answer", async () => {
    const messages = await prompt("Please upgrade it", () => ({ outcome: { outcome: "selected", optionId: "allow" } }));
    const asked = messages.find((m) => m.method === "session/request_permission");
    assert.equal(asked.params.toolCall.rawInput.command, "npm install");
    assert.ok(messages.indexOf(asked) < messages.findIndex((m) => m.id === 3));
    assert.equal(messages.at(-1).result.stopReason, "end_turn");
  });

  test("fails a turn scripted to fail", async () => {
    const messages = await prompt("Run the nightly suite");
    assert.equal(messages.at(-1).error.message, "Out of memory.");
  });
});

describe("the stubs come first on a login shell's PATH", { skip: !existsSync("/bin/zsh") }, () => {
  const cfg = devBbConfig({ SHOTS_ROOT: join(scratch, "pathcheck") });
  mkdirSync(cfg.bin, { recursive: true });
  mkdirSync(cfg.home, { recursive: true });

  test("the shims name their stub and its files in the root", () => {
    assert.match(claudeShim(cfg), new RegExp(`SHOTS_CLAUDE_PRINT="${join(cfg.root, "claude-print.json")}"`));
    assert.match(launchctlShim(cfg), /launchctl-stub\.mjs" "\$@"/);
    assert.match(shellProfile(cfg), new RegExp(`^export PATH="${cfg.bin}:\\$PATH"$`, "m"));
  });

  test("fails without the profile, and passes with it", () => {
    symlinkSync(process.execPath, join(cfg.bin, "node"));
    writeFileSync(join(cfg.bin, "claude"), claudeShim(cfg), { mode: 0o755 });
    writeFileSync(join(cfg.bin, "launchctl"), launchctlShim(cfg), { mode: 0o755 });
    assert.throws(() => assertStubsFirst(cfg), /finds launchctl at "\/bin\/launchctl"|finds claude/);
    for (const file of [".zprofile", ".zshrc"]) writeFileSync(join(cfg.home, file), shellProfile(cfg));
    assert.doesNotThrow(() => assertStubsFirst(cfg));
  });
});
