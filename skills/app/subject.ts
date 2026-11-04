/**
 * Whose skills a composer shows: its thread's, or — in the new-thread
 * composer — those of the thread its selection would start. The selection is
 * reactive (`useComposer().selection`), so a change of project, provider,
 * machine or environment is a new subject, with a key of its own, and the
 * list is asked for again.
 */
import type { ComposerSelection, PluginComposerScope } from "@get-bb/plugin-sdk/app";

import type { NewThreadSubject, SkillSubject } from "../shared/skills";

/** The composers that show the Skills button and popup. */
export function showsSkills(scope: PluginComposerScope): boolean {
  return scope.kind === "thread" || scope.kind === "new-thread";
}

/**
 * The machine and environment a new-thread selection names, if any: the
 * environment it would reuse, or the machine it would run on. Anything else
 * (the project's default, a provider that makes a machine) names neither, and
 * the server takes the project's default checkout.
 */
export function placeOf(
  environment: ComposerSelection["environment"],
): Pick<NewThreadSubject, "hostId" | "environmentId"> {
  if (environment?.type === "reuse") return { hostId: null, environmentId: environment.environmentId };
  if (environment?.type === "host") return { hostId: environment.hostId ?? null, environmentId: null };
  if (environment?.type === "provider" && environment.machine?.type === "existing") {
    return { hostId: environment.machine.hostId, environmentId: null };
  }
  return { hostId: null, environmentId: null };
}

/**
 * The subject of a composer, or null while there is none to ask for: a
 * composer that shows no skills, or a new-thread composer whose project or
 * provider bb has not resolved yet. The project is the scope's, bb's
 * effective selected project.
 */
export function subjectOf(scope: PluginComposerScope, selection: ComposerSelection | null): SkillSubject | null {
  if (scope.kind === "thread") return { threadId: scope.threadId };
  if (scope.kind !== "new-thread" || scope.projectId === null) return null;
  const providerId = selection?.providerId;
  if (providerId === undefined || providerId === "") return null;
  return { newThread: { projectId: scope.projectId, providerId, ...placeOf(selection?.environment) } };
}
