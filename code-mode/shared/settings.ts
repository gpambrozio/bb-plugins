// The one setting in bb's own settings form. The per-project and per-machine switches are on the
// plugin's settings page (shared/config.ts).
export const SPAWNED_SETTING = "spawnedThreads";

export const SPAWNED_OPTIONS = ["project-default", "off", "parent"] as const;
export type SpawnedRule = (typeof SPAWNED_OPTIONS)[number];

export const SPAWNED_LABELS: Record<SpawnedRule, string> = {
  "project-default": "Follow the project's default",
  off: "Never in Code Mode",
  parent: "Same as the thread that started it",
};

export function spawnedRule(value: unknown): SpawnedRule {
  return (SPAWNED_OPTIONS as readonly unknown[]).includes(value) ? (value as SpawnedRule) : "project-default";
}
