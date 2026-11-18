/**
 * Which projects the scheduler would dream, and the Dream page's project filters. No SDK import, so
 * the app uses it at run time; the sweep (`server/service.ts`) uses `dreamEligible` too, so the page's
 * "Dream eligible" is the scheduler's own check, not a copy of it. "Dry run pending" is the sidebar
 * badge's list (the dream machine's waiting dry runs), so the filter and the badge always agree.
 */
import type { ProjectStatus } from "./types";

/** A project the nightly sweep would dream: its switch is on and its gate says it is due. */
export function dreamEligible(status: Pick<ProjectStatus, "enabled" | "gate">): boolean {
  return status.enabled && status.gate.due;
}

export const PROJECT_FILTERS = ["all", "with-memory", "without-memory", "eligible", "pending"] as const;
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];

export const FILTER_LABELS: Record<ProjectFilter, string> = {
  all: "All projects",
  "with-memory": "With memory",
  "without-memory": "Without memory",
  eligible: "Dream eligible",
  pending: "Dry run pending",
};

/** `waiting`: the ids of the projects with a dry run waiting to be applied or discarded (the badge's list). */
export function matchesFilter(status: ProjectStatus, filter: ProjectFilter, waiting: ReadonlySet<string>): boolean {
  switch (filter) {
    case "all":
      return true;
    case "with-memory":
      return status.memory.files > 0;
    case "without-memory":
      return status.memory.files === 0;
    case "eligible":
      return dreamEligible(status);
    case "pending":
      return waiting.has(status.projectId);
  }
}
