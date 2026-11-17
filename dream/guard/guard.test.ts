// The tool limits a dream is held to, checked on every build (`npm test` in CI) against the guard
// itself, both as a module and run as Claude Code runs a PreToolUse hook.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GUARD_SOURCE } from "../host/guard-source";
import { decide, tokenize } from "./guard.mjs";

const GUARD = fileURLToPath(new URL("./guard.mjs", import.meta.url));

let root: string;
let memory: string;
let workspace: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-guard-")));
  memory = path.join(root, "memory");
  workspace = path.join(root, "workspace");
  mkdirSync(path.join(memory, "agents"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(root, "outside"), { recursive: true });
  symlinkSync(path.join(root, "outside"), path.join(memory, "escape"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function verdict(tool: string, toolInput: Record<string, unknown>): string {
  return decide({ tool_name: tool, tool_input: toolInput, cwd: workspace }, { memoryDir: memory }).decision;
}

const bash = (command: string) => verdict("Bash", { command });

describe("reads", () => {
  it("allows Read, Glob and Grep anywhere", () => {
    expect(verdict("Read", { file_path: "/etc/hosts" })).toBe("allow");
    expect(verdict("Glob", { pattern: "**/*.md" })).toBe("allow");
    expect(verdict("Grep", { pattern: "x", path: "/" })).toBe("allow");
  });
});

describe("writes", () => {
  it("allows Write and Edit of .md files in the memory folder", () => {
    expect(verdict("Write", { file_path: path.join(memory, "new.md") })).toBe("allow");
    expect(verdict("Edit", { file_path: path.join(memory, "MEMORY.md") })).toBe("allow");
    expect(verdict("Write", { file_path: path.join(memory, "topic", "deep.md") })).toBe("allow");
  });

  it("denies writes anywhere else", () => {
    expect(verdict("Write", { file_path: path.join(root, "outside", "x.md") })).toBe("deny");
    expect(verdict("Write", { file_path: path.join(workspace, "notes.md") })).toBe("deny");
    expect(verdict("Edit", { file_path: path.join(root, "repo", "README.md") })).toBe("deny");
    expect(verdict("Write", { file_path: `${memory}-sibling/x.md` })).toBe("deny");
  });

  it("denies a path that climbs, is relative, or leads out through a link", () => {
    expect(verdict("Write", { file_path: path.join(memory, "..", "outside", "x.md") })).toBe("deny");
    expect(verdict("Write", { file_path: "memory/x.md" })).toBe("deny");
    expect(verdict("Write", { file_path: path.join(memory, "escape", "x.md") })).toBe("deny");
  });

  it("denies files that are not .md, the lock, and the protected folders", () => {
    expect(verdict("Write", { file_path: path.join(memory, "script.sh") })).toBe("deny");
    expect(verdict("Write", { file_path: path.join(memory, ".consolidate-lock") })).toBe("deny");
    expect(verdict("Write", { file_path: path.join(memory, ".git", "x.md") })).toBe("deny");
    expect(verdict("Edit", { file_path: path.join(memory, "agents", "a.md") })).toBe("deny");
    expect(verdict("Write", { file_path: memory })).toBe("deny");
  });

  it("denies every other tool", () => {
    for (const tool of ["NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task", "Skill", "TodoWrite", "mcp__bb-bridge__bb_file_gateway", "MultiEdit"]) {
      expect(verdict(tool, {})).toBe("deny");
    }
    expect(decide({ tool_input: {} }, { memoryDir: memory }).decision).toBe("deny");
  });

  it("denies everything without a memory folder in its policy", () => {
    expect(decide({ tool_name: "Read", tool_input: {} }, {}).decision).toBe("deny");
  });
});

describe("the shell", () => {
  it("allows the read-only commands, piped into each other or chained", () => {
    expect(bash(`ls -la ${memory}`)).toBe("allow");
    expect(bash(`grep -rn "build failure" /x/projects/ --include="*.jsonl" | tail -50`)).toBe("allow");
    expect(bash(`find ${memory} -name '*.md' -mtime -3`)).toBe("allow");
    expect(bash(`cat ${memory}/MEMORY.md | wc -l`)).toBe("allow");
    expect(bash(`stat -f %m ${memory} && head -5 a.md; tail -n 20 b.md`)).toBe("allow");
    expect(bash(`grep -c 'a\\|b' x || echo none`)).toBe("deny");
    expect(bash(`grep -c 'a\\|b' x || wc -l x`)).toBe("allow");
  });

  it("allows rm -f of .md files in the memory folder only", () => {
    expect(bash(`rm -f ${memory}/stale.md`)).toBe("allow");
    expect(bash(`rm -f ${memory}/a.md ${memory}/b.md`)).toBe("allow");
    expect(bash(`rm -f -- ${memory}/a.md`)).toBe("allow");
    expect(bash(`rm ${memory}/stale.md`)).toBe("deny");
    expect(bash(`rm -rf ${memory}`)).toBe("deny");
    expect(bash(`rm -f ${memory}`)).toBe("deny");
    expect(bash(`rm -f ${memory}/*.md`)).toBe("deny");
    expect(bash(`rm -f ${memory}/notes.txt`)).toBe("deny");
    expect(bash(`rm -f ${memory}/agents/a.md`)).toBe("deny");
    expect(bash(`rm -f ${memory}/../repo/README.md`)).toBe("deny");
    expect(bash(`rm -f ${root}/repo/README.md`)).toBe("deny");
    expect(bash("rm -f stale.md")).toBe("deny");
  });

  it("denies other commands, writing options and following", () => {
    for (const command of [
      "touch x",
      "echo hi",
      "mkdir -p x",
      "cp a.md b.md",
      "mv a.md b.md",
      "sed -i s/a/b/ x.md",
      "git status",
      "/bin/ls",
      "FOO=1 ls",
      `find ${memory} -name '*.md' -delete`,
      `find . -exec rm {} \\;`,
      "find . -execdir cat {} +",
      "find . -fprint /tmp/out",
      "tail -f log",
      "tail -F log",
      "tail --follow=name log",
      "ls | sh",
      "cat x | xargs rm",
    ]) {
      expect(bash(command), command).toBe("deny");
    }
  });

  it("denies redirection, substitution, background and other shell syntax", () => {
    for (const command of [
      "echo hi > /tmp/x",
      "cat a >> b",
      "cat < /etc/passwd",
      "ls $(pwd)",
      "ls `pwd`",
      'grep "$HOME" x',
      "ls ${HOME}",
      "ls & ls",
      "(ls)",
      "ls\nrm -rf /",
      "ls #comment",
      "ls 'unterminated",
      "ls |",
      "",
    ]) {
      expect(bash(command), JSON.stringify(command)).toBe("deny");
    }
    expect(verdict("Bash", { command: "ls", run_in_background: true })).toBe("deny");
  });

  it("splits words and quotes as the shell does", () => {
    expect(tokenize(`grep -rn "a b" 'c|d' e\\ f | tail -5`)).toEqual({ segments: [["grep", "-rn", "a b", "c|d", "e f"], ["tail", "-5"]] });
    expect(tokenize('grep "a\\"b" x')).toEqual({ segments: [["grep", 'a"b', "x"]] });
  });
});

describe("the hook", () => {
  const policyFile = () => {
    const file = path.join(workspace, "policy.json");
    writeFileSync(file, JSON.stringify({ memoryDir: memory }));
    return file;
  };

  function hook(input: string, policy = policyFile()) {
    const result = spawnSync(process.execPath, [GUARD, policy], { input, encoding: "utf8" });
    return { status: result.status, answer: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
  }

  it("answers Claude Code's PreToolUse decision on stdout", () => {
    const allow = hook(JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(memory, "a.md") }, cwd: workspace }));
    expect(allow.status).toBe(0);
    expect(allow.answer.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow" });
    const deny = hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "touch x" }, cwd: workspace }));
    expect(deny.status).toBe(0);
    expect(deny.answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(deny.answer.hookSpecificOutput.permissionDecisionReason).toContain("touch");
  });

  it("fails closed, with exit 2, on bad input or a missing policy", () => {
    const garbage = hook("not json");
    expect(garbage.status).toBe(2);
    expect(garbage.answer.hookSpecificOutput.permissionDecision).toBe("deny");
    const noPolicy = hook(JSON.stringify({ tool_name: "Read", tool_input: {} }), path.join(root, "missing.json"));
    expect(noPolicy.status).toBe(2);
    expect(noPolicy.stderr).toContain("dream guard failed");
  });

  it("is what the host writes out", async () => {
    const { readFileSync } = await import("node:fs");
    expect(GUARD_SOURCE).toBe(readFileSync(GUARD, "utf8"));
  });
});
