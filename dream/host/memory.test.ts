import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalGitRoot, ENVIRONMENT_KEYS, hostEnvironment, resolveMemory, usableDir, type ResolveMemoryOptions } from "./memory";
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
