import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseFrontmatter } from "../shared/frontmatter";
import type { SkillDocument, SkillEntry } from "../shared/skills";
import { resolveClaudeSkills } from "./resolve/claude";
import { resolveCodexSkills } from "./resolve/codex";
import { resolveHermesSkills } from "./resolve/hermes";

export interface SkillRoots {
  claudeHome: string;
  codexHome: string;
  agentsHome: string;
  adminSkillsDir: string;
  /** `$HERMES_HOME` or `~/.hermes`. */
  hermesHome: string;
}

/**
 * The homes on the machine this runs on. `~/.agents` has no environment
 * override — Codex documents the literal path. `/etc/codex/skills` is a
 * constant for the same reason; on a machine without one it reads as an absent
 * directory, which is the normal case.
 *
 * `env` is the host worker's own environment, which bb's host daemon passed
 * it — not the agent's. See AGENTS.md for what that costs `CODEX_HOME` and
 * `HERMES_HOME`.
 */
export function defaultSkillRoots(env: NodeJS.ProcessEnv = process.env): SkillRoots {
  const home = os.homedir();
  return {
    claudeHome: path.join(home, ".claude"),
    codexHome: env.CODEX_HOME ?? path.join(home, ".codex"),
    agentsHome: path.join(home, ".agents"),
    adminSkillsDir: path.join(path.sep, "etc", "codex", "skills"),
    hermesHome: env.HERMES_HOME ?? path.join(home, ".hermes"),
  };
}

type Scanner = (cwd: string, roots: SkillRoots) => Promise<SkillEntry[]>;

/**
 * bb's provider ids whose skill directories are documented. Every other
 * provider still reaches the browser through bb's own skills and the list its
 * provider reports.
 */
const SCANNERS: Readonly<Record<string, Scanner>> = {
  "claude-code": (cwd, roots) => resolveClaudeSkills({ cwd, claudeHome: roots.claudeHome }),
  codex: (cwd, roots) =>
    resolveCodexSkills({
      cwd,
      codexHome: roots.codexHome,
      agentsHome: roots.agentsHome,
      adminSkillsDir: roots.adminSkillsDir,
    }),
  "acp-hermes-agent": (_cwd, roots) => resolveHermesSkills({ hermesHome: roots.hermesHome }),
};

export interface Discovery {
  scanned: boolean;
  skills: SkillEntry[];
}

export async function discoverSkills(
  input: { provider: string; cwd: string },
  roots: SkillRoots = defaultSkillRoots(),
): Promise<Discovery> {
  const scan = SCANNERS[input.provider];
  if (scan === undefined) return { scanned: false, skills: [] };
  return { scanned: true, skills: await scan(input.cwd, roots) };
}

/**
 * Takes a skill id, never a path. Discovery runs again and the id is looked up
 * in its result, so the only readable files are ones discovery already found.
 */
export async function readDiscoveredSkill(
  input: { provider: string; cwd: string; skillId: string },
  roots: SkillRoots = defaultSkillRoots(),
): Promise<SkillDocument> {
  const { skills } = await discoverSkills(input, roots);
  const skill = skills.find((entry) => entry.id === input.skillId);
  if (skill === undefined) throw new Error(`Skill not available: ${input.skillId}`);
  const raw = await readFile(skill.path, "utf8");
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    body: parseFrontmatter(raw).body,
  };
}
