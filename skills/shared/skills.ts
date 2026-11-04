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
  /** Where bb's list says it comes from; Add to chat hands it on to the pill. */
  origin: z.enum(["builtin", "project", "user"]),
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
  /**
   * Why bb's own skills could not be listed, when they come from another
   * machine than the thread's (a new thread off bb's primary host) and that
   * machine did not answer; null otherwise. The rest of the list stands.
   */
  bbError: z.string().nullable(),
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
export function dedupeByName<Entry extends { name: string }>(entries: Entry[]): Entry[] {
  const byName = new Map<string, Entry>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

/** Everything the browser lists, which is what the composer button's count promises. */
export function countEntries(list: SkillList): number {
  return list.skills.length + list.reported.skills.length + list.reported.commands.length;
}

const Id = z.string().min(1);

/**
 * A thread that does not exist yet: what the new-thread composer has selected.
 * Ids only, never a path: the server finds the directory itself, from the
 * project's checkout on the selected machine (or the environment it would
 * reuse). `hostId` and `environmentId` are null when the selection names
 * neither, and the project's default checkout is used.
 */
export const NewThreadSubjectSchema = z.object({
  projectId: Id,
  providerId: Id,
  hostId: Id.nullable(),
  environmentId: Id.nullable(),
});

export type NewThreadSubject = z.infer<typeof NewThreadSubjectSchema>;

/**
 * Whose skills a list is: a thread's, or a new thread's in the new-thread
 * composer. It is also the RPC input, so a thread's is the `{ threadId }` it
 * always was.
 */
export const SkillSubjectSchema = z.union([z.object({ threadId: Id }), z.object({ newThread: NewThreadSubjectSchema })]);

export type SkillSubject = z.infer<typeof SkillSubjectSchema>;

/**
 * One string per subject, for keying answers: two subjects that would scan the
 * same place for the same provider share it, and any change of project,
 * provider, machine or environment is a new key — a new list, never the old
 * one shown under it.
 */
export function subjectKey(subject: SkillSubject): string {
  if ("threadId" in subject) return `thread\n${subject.threadId}`;
  const { projectId, providerId, hostId, environmentId } = subject.newThread;
  return `new-thread\n${projectId}\n${providerId}\n${hostId ?? ""}\n${environmentId ?? ""}`;
}
