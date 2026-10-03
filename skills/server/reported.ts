/**
 * What bb's provider says a thread can run, as opposed to what was found on
 * disk. This is the only way to see commands and skills built into an agent
 * binary, which live on no scannable path, and the whole list for a provider
 * whose skill directories nobody has documented.
 */
import type { ReportedSkill } from "../shared/skills";

/** One row of `bb.sdk.projects.commands`, the list behind bb's own `/` menu. */
export interface ReportedCommand {
  name: string;
  description: string | null;
  argumentHint: string | null;
  source: "command" | "skill";
  origin: "builtin" | "project" | "user";
}

export interface ReportedSplit {
  skills: ReportedSkill[];
  commands: ReportedSkill[];
}

/**
 * Reported entries that discovery did not already find, split into skills and
 * session controls on the `source` the provider assigned.
 *
 * `source` is the provider's own judgement, not ground truth, and it is the
 * same split bb's `/` menu shows — so the browser at least agrees with the
 * composer. A name reported twice is listed once, under the first row.
 */
export function selectReported(
  commands: readonly ReportedCommand[],
  discoveredNames: readonly string[],
): ReportedSplit {
  const seen = new Set(discoveredNames);
  const split: ReportedSplit = { skills: [], commands: [] };
  for (const command of commands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    const bucket = command.source === "command" ? split.commands : split.skills;
    bucket.push({
      name: command.name,
      description: command.description ?? "",
      argumentHint: command.argumentHint ?? "",
      origin: command.origin,
    });
  }
  const byName = (a: ReportedSkill, b: ReportedSkill) => a.name.localeCompare(b.name);
  split.skills.sort(byName);
  split.commands.sort(byName);
  return split;
}
