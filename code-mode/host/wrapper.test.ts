// The wrapper: its decisions as functions, and the launcher run for real with a fake claude, the way
// bb runs it (through /bin/sh, with this Node as the host daemon's).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as wrapper from "../wrapper/code-mode-wrapper.mjs";
import { installWrapper, LAUNCHER_NAME, SCRIPT_NAME } from "./install";
import { launcherScript, shellQuote } from "./launcher";
import { WRAPPER_SOURCE } from "./wrapper.generated";

const FLAG = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";
const SDK = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-mode-wrapper-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function transcript(home: string, session: string, lines: unknown[]): void {
  const dir = join(home, ".claude", "projects", "-some-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

describe("the generated module", () => {
  it("is the wrapper byte for byte (run `npm run gen:wrapper` after changing it)", () => {
    expect(WRAPPER_SOURCE).toBe(readFileSync(new URL("../wrapper/code-mode-wrapper.mjs", import.meta.url), "utf8"));
  });
});

describe("the settings merge", () => {
  it("adds the flag to bb's --settings JSON and keeps every other key", () => {
    const settings = JSON.stringify({ autoMemoryEnabled: true, fastMode: false, env: { OTHER: "x" } });
    const plan = wrapper.withFlag([...SDK, "--settings", settings, "--model", "claude-opus-5-5"]);
    expect(plan.action).toBe("replace");
    expect(plan.index).toBe(SDK.length + 1);
    expect(JSON.parse(plan.value)).toEqual({ autoMemoryEnabled: true, fastMode: false, env: { OTHER: "x", [FLAG]: "1" } });
  });

  it("handles the --settings=JSON form", () => {
    const plan = wrapper.withFlag([...SDK, `--settings={"ultracode":true}`]);
    expect(plan).toMatchObject({ action: "replace", index: SDK.length });
    expect(plan.value.startsWith("--settings=")).toBe(true);
    expect(JSON.parse(plan.value.slice("--settings=".length))).toEqual({ ultracode: true, env: { [FLAG]: "1" } });
  });

  it("uses the last --settings when bb passes several", () => {
    const plan = wrapper.withFlag(["--settings", "{}", "--settings", `{"a":1}`]);
    expect(plan.index).toBe(3);
    expect(JSON.parse(plan.value)).toEqual({ a: 1, env: { [FLAG]: "1" } });
  });

  it("appends a --settings when bb passed none", () => {
    expect(wrapper.withFlag(SDK)).toEqual({ action: "append", value: JSON.stringify({ env: { [FLAG]: "1" } }) });
  });

  it("refuses what it can't merge, so the launch passes through", () => {
    expect(() => wrapper.withFlag(["--settings", "/path/to/settings.json"])).toThrow();
    expect(() => wrapper.withFlag(["--settings", "[1]"])).toThrow();
    expect(() => wrapper.withFlag(["--settings", `{"env":"x"}`])).toThrow();
  });
});

describe("decide", () => {
  const home = () => join(root, "home");

  it("passes through anything that is not an SDK session", () => {
    expect(wrapper.decide(["--version"], {}, home())).toMatchObject({ plan: { action: "pass" }, reason: "not an SDK session" });
    expect(wrapper.decide(["doctor"], {}, home()).decision).toBe("pass");
  });

  it("passes through when it is already wrapped", () => {
    expect(wrapper.decide(SDK, { BB_CODE_MODE_WRAPPED: "1" }, home())).toMatchObject({ decision: "pass", reason: "already wrapped" });
  });

  it("turns Code Mode on for a new SDK session", () => {
    expect(wrapper.decide(SDK, {}, home())).toMatchObject({ decision: "on", reason: "new session" });
  });

  it("resumes a Code Mode session in Code Mode", () => {
    transcript(home(), "s-on", [{ type: "user" }, { type: "repl-mode", replMode: true }]);
    expect(wrapper.decide([...SDK, "--resume", "s-on"], {}, home())).toMatchObject({ decision: "on", reason: "resumed Code Mode session", session: "s-on" });
  });

  it("resumes a session that started without Code Mode as it started", () => {
    transcript(home(), "s-off", [{ type: "user" }, { type: "assistant" }]);
    expect(wrapper.decide([...SDK, "--resume=s-off"], {}, home())).toMatchObject({ decision: "pass", reason: "resumed session started without Code Mode" });
    transcript(home(), "s-turned-off", [{ type: "repl-mode", replMode: true }, { type: "repl-mode", replMode: false }]);
    expect(wrapper.decide([...SDK, "--resume", "s-turned-off"], {}, home()).decision).toBe("pass");
  });

  it("turns Code Mode on for a resume with no transcript", () => {
    expect(wrapper.decide([...SDK, "--resume", "gone"], {}, home())).toMatchObject({ decision: "on", reason: "resumed session, no transcript found" });
  });

  it("reads transcripts from CLAUDE_CONFIG_DIR", () => {
    const config = join(root, "config");
    mkdirSync(join(config, "projects", "p"), { recursive: true });
    writeFileSync(join(config, "projects", "p", "s.jsonl"), `${JSON.stringify({ type: "user" })}\n`);
    expect(wrapper.decide([...SDK, "--resume", "s"], { CLAUDE_CONFIG_DIR: config }, home()).decision).toBe("pass");
  });

  it("never looks up a session id that could leave the projects folder", () => {
    expect(wrapper.startedInCodeMode("../../etc/passwd", {}, home())).toBeNull();
  });
});

describe("the real claude lookup", () => {
  function executable(path: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  }

  it("prefers ~/.local/bin/claude, then PATH, and never picks the wrapper itself", () => {
    const home = join(root, "home");
    const onPath = executable(join(root, "bin", "claude"));
    expect(wrapper.realClaude({ PATH: join(root, "bin") }, home, [])).toBe(onPath);
    const local = executable(join(home, ".local", "bin", "claude"));
    expect(wrapper.realClaude({ PATH: join(root, "bin") }, home, [])).toBe(local);
    expect(wrapper.realClaude({ PATH: join(root, "bin") }, home, [local])).toBe(onPath);
    expect(wrapper.realClaude({ PATH: "" }, home, [local])).toBeNull();
  });
});

describe("the launcher", () => {
  /** A fake claude that prints what it was run with. */
  function fakeClaude(path: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), wrapped: process.env.BB_CODE_MODE_WRAPPED ?? null, electron: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  async function installed(): Promise<string> {
    const result = await installWrapper({ dataDir: join(root, "host-data"), node: process.execPath, platform: process.platform });
    if (!result.ok) throw new Error(result.reason);
    return result.path;
  }

  function run(launcher: string, args: string[], env: Record<string, string>) {
    const out = execFileSync(launcher, args, { env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), ...env }, encoding: "utf8" });
    return JSON.parse(out) as { args: string[]; wrapped: string | null; electron: string | null };
  }

  it("execs the real claude with the flag merged into --settings, and nothing else changed", async () => {
    const launcher = await installed();
    const claude = fakeClaude(join(root, "home", ".local", "bin", "claude"));
    expect(claude).toBeTruthy();
    const settings = JSON.stringify({ autoMemoryEnabled: true });
    const args = [...SDK, "--settings", settings, "--model", "claude-opus-5-5", "--append-system-prompt", "it's a \"quoted\"\nmulti-line arg"];
    const seen = run(launcher, args, { BB_THREAD_ID: "thr_1" });
    expect(seen.args.length).toBe(args.length);
    expect(JSON.parse(seen.args[SDK.length + 1]!)).toEqual({ autoMemoryEnabled: true, env: { [FLAG]: "1" } });
    expect(seen.args.filter((_, index) => index !== SDK.length + 1)).toEqual(args.filter((_, index) => index !== SDK.length + 1));
    expect(seen.wrapped).toBe("1");
    expect(seen.electron).toBeNull();
  });

  it("passes a non-SDK command through untouched", async () => {
    const launcher = await installed();
    fakeClaude(join(root, "home", ".local", "bin", "claude"));
    expect(run(launcher, ["--version"], {}).args).toEqual(["--version"]);
  });

  it("appends --settings when bb passed none", async () => {
    const launcher = await installed();
    fakeClaude(join(root, "home", ".local", "bin", "claude"));
    const seen = run(launcher, SDK, {});
    expect(seen.args.slice(0, SDK.length)).toEqual(SDK);
    expect(seen.args.slice(SDK.length)).toEqual(["--settings", JSON.stringify({ env: { [FLAG]: "1" } })]);
  });

  it("logs one line per launch, with no arguments or environment values", async () => {
    const launcher = await installed();
    fakeClaude(join(root, "home", ".local", "bin", "claude"));
    run(launcher, [...SDK, "--settings", `{"secret":"prompt text"}`], { BB_THREAD_ID: "thr_log", SOME_TOKEN: "token-value" });
    const log = readFileSync(join(root, "host-data", "wrapper.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    const entry = JSON.parse(log[0]!);
    expect(entry).toMatchObject({ thread: "thr_log", decision: "on", reason: "new session", session: null });
    expect(Object.keys(entry).sort()).toEqual(["at", "decision", "pid", "reason", "session", "thread"]);
    expect(log[0]).not.toContain("prompt text");
    expect(log[0]).not.toContain("token-value");
  });

  it("runs claude exactly as asked when the daemon's Node is gone", async () => {
    const dataDir = join(root, "broken");
    mkdirSync(dataDir, { recursive: true });
    const launcher = join(dataDir, LAUNCHER_NAME);
    writeFileSync(launcher, launcherScript({ node: join(root, "no-such-node"), script: join(dataDir, SCRIPT_NAME) }));
    chmodSync(launcher, 0o755);
    fakeClaude(join(root, "home", ".local", "bin", "claude"));
    expect(run(launcher, [...SDK, "--settings", "{}"], {}).args).toEqual([...SDK, "--settings", "{}"]);
  });

  it("fails with a message when there is no real claude", async () => {
    const launcher = await installed();
    const result = spawnSync(launcher, SDK, { env: { PATH: "/usr/bin:/bin", HOME: join(root, "home") }, encoding: "utf8" });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("no real claude found");
  });
});

describe("installWrapper", () => {
  it("writes the launcher executable and the script beside it, and says where", async () => {
    const dataDir = join(root, "data dir with 'quotes'");
    const result = await installWrapper({ dataDir, node: process.execPath, platform: process.platform });
    expect(result).toEqual({ ok: true, path: join(dataDir, LAUNCHER_NAME) });
    expect(statSync(join(dataDir, LAUNCHER_NAME)).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dataDir, SCRIPT_NAME), "utf8")).toBe(WRAPPER_SOURCE);
    expect(readFileSync(join(dataDir, LAUNCHER_NAME), "utf8")).toContain(shellQuote(join(dataDir, SCRIPT_NAME)));
  });

  it("puts back a launcher that lost its execute bit", async () => {
    const dataDir = join(root, "data");
    await installWrapper({ dataDir, node: process.execPath, platform: process.platform });
    chmodSync(join(dataDir, LAUNCHER_NAME), 0o644);
    await installWrapper({ dataDir, node: process.execPath, platform: process.platform });
    expect(statSync(join(dataDir, LAUNCHER_NAME)).mode & 0o777).toBe(0o755);
  });

  it("refuses Windows and a missing Node", async () => {
    expect(await installWrapper({ dataDir: join(root, "w"), node: process.execPath, platform: "win32" })).toMatchObject({ ok: false });
    expect(await installWrapper({ dataDir: join(root, "n"), node: join(root, "no-node"), platform: process.platform })).toMatchObject({ ok: false });
  });
});

describe("shellQuote", () => {
  it("survives quotes and spaces", () => {
    const value = `a b 'c' "d" $e`;
    expect(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" })).toBe(value);
  });
});
