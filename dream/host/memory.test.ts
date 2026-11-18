import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalGitRoot, ENVIRONMENT_KEYS, MAX_WORKTREE_INCLUDE_BYTES, worktreesGetLocalSettings, hostEnvironment, resolveMemory, usableDir, type ResolveMemoryOptions } from "./memory";
import { MAX_SLUG_LENGTH, pathHash, projectSlug } from "./slug";

let root: string;
let home: string;
let checkout: string;
let managed: string;

function write(file: string, content: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function options(overrides: Partial<ResolveMemoryOptions> = {}): ResolveMemoryOptions {
  return { checkout, home, env: {}, managedDirs: [managed], ...overrides };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-memory-")));
  home = path.join(root, "home");
  checkout = path.join(root, "repos", "app");
  managed = path.join(root, "managed");
  mkdirSync(path.join(checkout, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("projectSlug", () => {
  it("replaces every character that is not an ASCII letter or digit", () => {
    expect(projectSlug("/Users/me/repositories/bb-plugins")).toBe("-Users-me-repositories-bb-plugins");
    expect(projectSlug("/Users/me/.bb/plugins/x_y/thr_ab12-1/café")).toBe("-Users-me--bb-plugins-x-y-thr-ab12-1-caf-");
  });

  it("cuts a long name at 200 characters and adds the path's hash in base 36", () => {
    const long = `/${"a".repeat(250)}`;
    const slug = projectSlug(long);
    expect(slug.slice(0, MAX_SLUG_LENGTH)).toBe(`-${"a".repeat(199)}`);
    expect(slug).toBe(`${`-${"a".repeat(199)}`}-${Math.abs(pathHash(long)).toString(36)}`);
  });

  it("hashes like Java's String.hashCode", () => {
    expect(pathHash("hello")).toBe(99162322);
    expect(pathHash("")).toBe(0);
  });
});

describe("usableDir", () => {
  it("expands ~/ only when asked, and refuses relative or climbing values", () => {
    expect(usableDir("~/mem/app", true, "/h")).toBe("/h/mem/app");
    expect(usableDir("~/mem/app", false, "/h")).toBeUndefined();
    expect(usableDir("~/../etc", true, "/h")).toBeUndefined();
    expect(usableDir("relative/dir", true, "/h")).toBeUndefined();
    expect(usableDir("/abs/dir///", true, "/h")).toBe("/abs/dir");
    expect(usableDir("/", true, "/h")).toBeUndefined();
  });
});

describe("resolveMemory", () => {
  it("uses <config>/projects/<slug>/memory with no override", () => {
    const resolved = resolveMemory(options());
    expect(resolved.source).toBe("default");
    expect(resolved.dir).toBe(path.join(home, ".claude", "projects", projectSlug(checkout), "memory"));
    expect(resolved.warnings).toEqual([]);
    expect(resolved.autoMemoryEnabled).toBe(true);
  });

  it("honours a custom folder in the tracked project settings, expanding ~", () => {
    write(path.join(checkout, ".claude", "settings.json"), { autoMemoryDirectory: "~/agent-memory/app" });
    const resolved = resolveMemory(options());
    expect(resolved).toMatchObject({ source: "projectSettings", dir: path.join(home, "agent-memory", "app"), configured: "~/agent-memory/app" });
  });

  it("puts local settings before project settings, and policy before both", () => {
    write(path.join(checkout, ".claude", "settings.json"), { autoMemoryDirectory: "/project/mem" });
    write(path.join(checkout, ".claude", "settings.local.json"), { autoMemoryDirectory: "/local/mem" });
    expect(resolveMemory(options()).dir).toBe("/local/mem");
    write(path.join(managed, "managed-settings.json"), { autoMemoryDirectory: "/policy/mem" });
    expect(resolveMemory(options())).toMatchObject({ source: "policySettings", dir: "/policy/mem" });
  });

  it("puts the environment override first, taken as written", () => {
    write(path.join(checkout, ".claude", "settings.json"), { autoMemoryDirectory: "/project/mem" });
    expect(resolveMemory(options({ env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "/env/mem" } }))).toMatchObject({ source: "env", dir: "/env/mem" });
  });

  it("reads user settings from CLAUDE_CONFIG_DIR, and the default folder too", () => {
    const config = path.join(root, "config");
    write(path.join(config, "settings.json"), { autoMemoryEnabled: false });
    const resolved = resolveMemory(options({ env: { CLAUDE_CONFIG_DIR: config } }));
    expect(resolved.dir).toBe(path.join(config, "projects", projectSlug(checkout), "memory"));
    expect(resolved.autoMemoryEnabled).toBe(false);
  });

  it("falls back to the default when the first source that sets the key has an unusable value", () => {
    write(path.join(checkout, ".claude", "settings.local.json"), { autoMemoryDirectory: "not/absolute" });
    write(path.join(home, ".claude", "settings.json"), { autoMemoryDirectory: "/user/mem" });
    const resolved = resolveMemory(options());
    expect(resolved.source).toBe("default");
    expect(resolved.warnings.join("\n")).toContain("not a usable folder");
  });

  it("reports an override set only in settings.local.json, which worktrees do not see", () => {
    write(path.join(checkout, ".claude", "settings.local.json"), { autoMemoryDirectory: "~/agent-memory/app" });
    const resolved = resolveMemory(options());
    expect(resolved.source).toBe("localSettings");
    expect(resolved.warnings.join("\n")).toContain("only in .claude/settings.local.json");
    expect(resolved.warnings.join("\n")).toContain(path.join(home, ".claude", "projects", projectSlug(checkout), "memory"));
  });

  it("reports a local-only override in a linked worktree or submodule checkout, whose .git is a file", () => {
    const linked = path.join(root, "repos", "linked");
    const gitDir = path.join(checkout, ".git", "worktrees", "linked");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    mkdirSync(linked, { recursive: true });
    writeFileSync(path.join(linked, ".git"), `gitdir: ${gitDir}\n`);
    write(path.join(linked, ".claude", "settings.local.json"), { autoMemoryDirectory: "~/agent-memory/app" });
    expect(resolveMemory(options({ checkout: linked })).warnings.join("\n")).toContain("only in .claude/settings.local.json");

    const submodule = path.join(root, "repos", "sub");
    mkdirSync(submodule, { recursive: true });
    writeFileSync(path.join(submodule, ".git"), "gitdir: ../app/.git/modules/sub\n");
    write(path.join(submodule, ".claude", "settings.local.json"), { autoMemoryDirectory: "~/agent-memory/sub" });
    expect(resolveMemory(options({ checkout: submodule })).warnings.join("\n")).toContain("only in .claude/settings.local.json");
  });

  it("does not report a local-only override in a folder outside git, which has no worktrees", () => {
    const plain = path.join(root, "Documents", "OnShape");
    write(path.join(plain, ".claude", "settings.local.json"), { autoMemoryDirectory: "~/agent-memory/OnShape" });
    const resolved = resolveMemory(options({ checkout: plain }));
    expect(resolved).toMatchObject({ source: "localSettings", dir: path.join(home, "agent-memory", "OnShape") });
    expect(resolved.warnings).toEqual([]);
  });

  describe("with a .worktreeinclude, which bb uses to copy untracked files into new worktrees", () => {
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" });
    let repo: string;
    const warned = () => resolveMemory(options({ checkout: repo })).warnings.join("\n").includes("only in .claude/settings.local.json");

    beforeEach(() => {
      repo = path.join(root, "repos", "real");
      mkdirSync(repo, { recursive: true });
      git("init", "-q", "-b", "main");
      write(path.join(repo, "README.md"), "app\n");
      write(path.join(repo, ".claude", "settings.local.json"), { autoMemoryDirectory: "~/agent-memory/real" });
    });

    it("stays quiet when a committed .worktreeinclude copies the file", () => {
      write(path.join(repo, ".worktreeinclude"), "# local files\n.env\n.claude/settings.local.json\n");
      git("add", "README.md", ".worktreeinclude");
      git("commit", "-q", "-m", "init");
      expect(worktreesGetLocalSettings(repo)).toBe(true);
      expect(warned()).toBe(false);
      expect(resolveMemory(options({ checkout: repo })).dir).toBe(path.join(home, "agent-memory", "real"));
    });

    it("stays quiet when an untracked .worktreeinclude, hidden through .git/info/exclude, copies its folder", () => {
      write(path.join(repo, ".worktreeinclude"), ".claude/\n");
      write(path.join(repo, ".git", "info", "exclude"), ".worktreeinclude\n");
      git("add", "README.md");
      git("commit", "-q", "-m", "init");
      expect(warned()).toBe(false);
    });

    it("warns when the .worktreeinclude negates the file", () => {
      write(path.join(repo, ".worktreeinclude"), ".claude/*\n!.claude/settings.local.json\n");
      expect(worktreesGetLocalSettings(repo)).toBe(false);
      expect(warned()).toBe(true);
    });

    it("warns when the .worktreeinclude does not match the file, has only comments, or is missing", () => {
      expect(warned()).toBe(true);
      write(path.join(repo, ".worktreeinclude"), ".env\n.env.*\n");
      expect(warned()).toBe(true);
      write(path.join(repo, ".worktreeinclude"), "# .claude/settings.local.json\n\n");
      expect(warned()).toBe(true);
    });

    it("never runs a fsmonitor program the repository configures, and still matches", () => {
      write(path.join(repo, ".worktreeinclude"), ".claude/settings.local.json\n");
      git("add", "README.md", ".worktreeinclude");
      git("commit", "-q", "-m", "init");
      const sentinel = path.join(root, "fsmonitor-ran");
      const hook = path.join(root, "fsmonitor.sh");
      writeFileSync(hook, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`);
      chmodSync(hook, 0o755);
      git("config", "core.fsmonitor", hook);
      expect(warned()).toBe(false);
      expect(existsSync(sentinel)).toBe(false);
    });

    it("keeps the warning, without reading or blocking, when .worktreeinclude is a FIFO, a link or too large", () => {
      const include = path.join(repo, ".worktreeinclude");
      // A FIFO: opening it to read would block for good.
      execFileSync("mkfifo", [include]);
      expect(warned()).toBe(true);
      // A link, to a FIFO or to a file that would match: bb's own read follows it, ours never does.
      rmSync(include);
      const fifo = path.join(root, "fifo");
      execFileSync("mkfifo", [fifo]);
      symlinkSync(fifo, include);
      expect(warned()).toBe(true);
      rmSync(include);
      write(path.join(root, "patterns"), ".claude/settings.local.json\n");
      symlinkSync(path.join(root, "patterns"), include);
      expect(warned()).toBe(true);
      // Larger than the cap, though it matches.
      rmSync(include);
      write(include, `.claude/settings.local.json\n${"#".repeat(MAX_WORKTREE_INCLUDE_BYTES)}\n`);
      expect(warned()).toBe(true);
      write(include, ".claude/settings.local.json\n");
      expect(warned()).toBe(false);
    });

    it("warns when the file is a symbolic link, which bb does not copy", () => {
      write(path.join(repo, "real-settings.json"), { autoMemoryDirectory: "~/agent-memory/real" });
      rmSync(path.join(repo, ".claude", "settings.local.json"));
      symlinkSync(path.join(repo, "real-settings.json"), path.join(repo, ".claude", "settings.local.json"));
      write(path.join(repo, ".worktreeinclude"), ".claude/settings.local.json\n");
      expect(warned()).toBe(true);
    });
  });

  it("does not report a local override that the tracked settings repeat", () => {
    write(path.join(checkout, ".claude", "settings.local.json"), { autoMemoryDirectory: "/same/mem" });
    write(path.join(checkout, ".claude", "settings.json"), { autoMemoryDirectory: "/same/mem" });
    expect(resolveMemory(options()).warnings).toEqual([]);
  });

  it("reports, and does not touch, a legacy default folder that still holds files", () => {
    write(path.join(checkout, ".claude", "settings.json"), { autoMemoryDirectory: "~/agent-memory/app" });
    const legacy = path.join(home, ".claude", "projects", projectSlug(checkout), "memory");
    write(path.join(legacy, "old.md"), "old");
    write(path.join(legacy, "MEMORY.md"), "- [Old](old.md)");
    const resolved = resolveMemory(options());
    expect(resolved.dir).toBe(path.join(home, "agent-memory", "app"));
    expect(resolved.warnings.join("\n")).toContain(`${legacy} still holds 2 .md files`);
  });

  it("maps a worktree checkout to its main checkout's folder", () => {
    const worktree = path.join(root, "worktrees", "thr_abc-1", "app");
    const gitDir = path.join(checkout, ".git", "worktrees", "app");
    write(path.join(gitDir, "commondir"), "../..\n");
    write(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(canonicalGitRoot(worktree)).toBe(checkout);
    expect(resolveMemory(options({ checkout: worktree })).dir).toBe(path.join(home, ".claude", "projects", projectSlug(checkout), "memory"));
  });

  it("uses the folder itself outside git", () => {
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    expect(canonicalGitRoot(plain)).toBeNull();
    expect(resolveMemory(options({ checkout: plain })).dir).toBe(path.join(home, ".claude", "projects", projectSlug(plain), "memory"));
  });

  it("turns auto memory off with CLAUDE_CODE_DISABLE_AUTO_MEMORY", () => {
    expect(resolveMemory(options({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } })).autoMemoryEnabled).toBe(false);
  });
});

describe("hostEnvironment", () => {
  it("forwards every variable the resolution and the hook checks read, the hook-off ones included", () => {
    const env = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, `v-${key}`]));
    expect(hostEnvironment({ ...env, UNRELATED: "x" })).toEqual(env);
    expect(hostEnvironment({ CLAUDE_CODE_PERSONAL_HOOKS_OFF: "1", CLAUDE_CODE_SIMPLE: "1" })).toEqual({ CLAUDE_CODE_PERSONAL_HOOKS_OFF: "1", CLAUDE_CODE_SIMPLE: "1" });
  });

  it("is what the production host entry uses", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(import.meta.dirname, "..", "host.ts"), "utf8");
    expect(source).toMatch(/env: hostEnvironment\(process\.env\)/);
  });
});
