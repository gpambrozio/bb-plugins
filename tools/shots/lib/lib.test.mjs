// Unit tests for the harness's pure parts. Run with `npm test` in tools/shots; nothing here starts bb
// or a browser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SEND_ROUTES } from "./browser.mjs";
import { assertIsolated, descendantsOf, devBbConfig, devBbEnv, removeRoot } from "./devbb.mjs";
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
  const run = (args, input = "") => spawnSync(process.execPath, [stub, ...args], { input, encoding: "utf8" });

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
  });
});
