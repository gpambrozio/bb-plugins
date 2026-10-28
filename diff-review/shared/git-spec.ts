/**
 * The views only raw git gives, which the plugin's host entry computes on the machine that holds the
 * workspace: staged (HEAD against the index), unstaged (the index against the working tree, untracked
 * files included) and a range between two revisions, `a..b` or `a...b`. No SDK import: the app uses
 * these at run time.
 */
import { z } from "zod";

/**
 * A revision as the plugin passes it to git: a branch, tag, SHA or `HEAD`, with `~`, `^`, `@{…}`. It
 * may not start with `-`, so git never takes it for an option.
 */
export const revisionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_./@{}~^+][A-Za-z0-9_./@{}~^+-]*$/, "Not a revision git takes")
  .refine((value) => !value.includes(".."), "A revision has no '..' in it");

export const hostDiffSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("staged") }).strict(),
  z.object({ kind: z.literal("unstaged") }).strict(),
  /** `symmetric`: `from...to` (the changes on `to` since it forked from `from`); otherwise `from..to`. */
  z.object({ kind: z.literal("range"), from: revisionSchema, to: revisionSchema, symmetric: z.boolean() }).strict(),
]);
export type HostDiffSpec = z.infer<typeof hostDiffSpecSchema>;

/** `a..b` or `a...b` as a range spec, or null when it is not one. An empty side is `HEAD`, as git takes it. */
export function parseRange(text: string): Extract<HostDiffSpec, { kind: "range" }> | null {
  const trimmed = text.trim();
  const symmetric = trimmed.includes("...");
  const parts = trimmed.split(symmetric ? "..." : "..");
  if (parts.length !== 2) return null;
  const from = parts[0] === "" ? "HEAD" : parts[0]!;
  const to = parts[1] === "" ? "HEAD" : parts[1]!;
  const spec = { kind: "range" as const, from, to, symmetric };
  return hostDiffSpecSchema.safeParse(spec).success ? spec : null;
}

export function rangeText(spec: { from: string; to: string; symmetric: boolean }): string {
  return `${spec.from}${spec.symmetric ? "..." : ".."}${spec.to}`;
}
