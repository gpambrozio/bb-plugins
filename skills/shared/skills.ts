/**
 * The shapes every runtime shares: the host entry produces skill entries, the
 * server adds bb's own skills and the reported list, and the app draws them.
 *
 * No SDK import, so the app bundle may use this module at run time.
 */
import { z } from "zod";

/**
 * Scopes, not directories, in precedence order — the order the browser draws
 * its groups in. Several directories feed most scopes (Codex reads
 * `.agents/skills` and `.codex/skills` in the same walk), so a kind names where
 * a skill applies and `SkillSource.dir` names where it is.
 *
 * `bb` is last: the skills bb itself injects into every thread (its plugins',
 * `~/.bb/skills` and the workspace's `.bb/skills`), listed after the
 * provider's own.
 *
 * This is the only list of kinds. The type, the zod enum and the browser's
 * group order are all read off it, so a new kind cannot sort to the wrong place
 * or fail validation at run time.
 */
export const SOURCE_KINDS = ["project", "repo", "personal", "admin", "plugin", "bb"] as const;

export type SkillSourceKind = (typeof SOURCE_KINDS)[number];

export const SkillSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  label: z.string(),
  dir: z.string(),
});

export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillEntrySchema = z.object({
  id: z.string(),
  /** The invocation name; `plugin:skill` for a Claude plugin's skills. */
  name: z.string(),
  description: z.string(),
  source: SkillSourceSchema,
  /** Absolute `SKILL.md` path, on the machine the thread runs on. */
  path: z.string(),
  userInvocable: z.boolean(),
  status: z.enum(["discovered"]),
});

export type SkillEntry = z.infer<typeof SkillEntrySchema>;

export const ReportedSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
});

export type ReportedSkill = z.infer<typeof ReportedSkillSchema>;

/**
 * What bb's provider says the thread can run, minus everything discovery
 * already found, split on the provider's own `source`. When the list could not
 * be had, `error` says why and the browser shows it under its own heading
 * rather than leaving a silent gap.
 */
export const ReportedSkillsSchema = z.object({
  error: z.string().nullable(),
  skills: z.array(ReportedSkillSchema),
  commands: z.array(ReportedSkillSchema),
});

export type ReportedSkills = z.infer<typeof ReportedSkillsSchema>;

export const SkillListSchema = z.object({
  /** bb's provider id: `claude-code`, `codex`, `acp-hermes-agent`, … */
  provider: z.string(),
  /**
   * Whether filesystem discovery ran for this provider — not whether the
   * browser has anything to show. Every provider gets bb's own skills and a
   * reported section regardless.
   */
  scanned: z.boolean(),
  cwd: z.string(),
  skills: z.array(SkillEntrySchema),
  reported: ReportedSkillsSchema,
});

export type SkillList = z.infer<typeof SkillListSchema>;

export const SkillDocumentSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  body: z.string(),
});

export type SkillDocument = z.infer<typeof SkillDocumentSchema>;

/**
 * First name wins. Callers pass entries in precedence order, so a project skill
 * shadows a personal one of the same name without either being listed twice.
 */
export function dedupeByName(entries: SkillEntry[]): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

/** Everything the browser lists, which is what the composer button's count promises. */
export function countEntries(list: SkillList): number {
  return list.skills.length + list.reported.skills.length + list.reported.commands.length;
}
