/**
 * The shapes of an orientation: a repository summary plus a walkthrough made of blocks (chapters,
 * notes and code listings). Plain zod and constants, no SDK import, so the app bundle can import it at
 * run time (see the root AGENTS.md, *Dependencies*).
 */
import { z } from "zod";

import { WorkspaceSchema } from "./types";

/** The limits every orientation input is held to; the tools and the stored shapes share them. */
export const ORIENT_LIMITS = {
  noteChars: 8_000,
  captionChars: 200,
  listingLines: 200,
  listings: 60,
  fileBytes: 1_048_576,
  purposeChars: 300,
  /** Each other prose string of the summary: a stage, what a key file does and why, a gotcha, … */
  summaryText: 500,
  /** Each name or path in the summary: a language, a key file's path, a concept's name and where, a source. */
  summaryName: 200,
  chapterChars: 120,
  languages: { min: 1, max: 6 },
  stages: { min: 1, max: 10 },
  keyFiles: { min: 6, max: 10 },
  concepts: { min: 3, max: 5 },
  gotchas: { min: 2, max: 3 },
  exercises: 2,
  sources: { min: 1, max: 40 },
} as const;

export const ORIENTATION_STATUSES = ["starting", "building", "ready", "failed", "cancelled"] as const;
export type OrientationStatus = (typeof ORIENTATION_STATUSES)[number];
/** The statuses in which the orientation's thread is still working on it. */
export const LIVE_ORIENTATION_STATUSES = ["starting", "building"] as const;

export const OrientationDepthSchema = z.enum(["summary", "walkthrough"]);
export type OrientationDepth = z.infer<typeof OrientationDepthSchema>;

/** No line break of any kind: LF, CR, and the Unicode line and paragraph separators. */
const ONE_LINE = /^[^\n\r\u2028\u2029]*$/;

/**
 * One summary string: non-empty, within `max`, and one line. The export puts each one on a line of its
 * own or after a list marker, so a line break would let a field start a line of the file, where showboat
 * reads a fence as a code block that `showboat verify` runs (and `![…](…)` as an image).
 */
function summaryLine(max: number) {
  return z.string().min(1).max(max).regex(ONE_LINE, "Must be one line: no line breaks.");
}

const prose = () => summaryLine(ORIENT_LIMITS.summaryText);
const name = () => summaryLine(ORIENT_LIMITS.summaryName);

/**
 * The structured summary of a repository. Flat on purpose: no `.refine`, nothing that converts to a
 * JSON Schema `$ref`, because it is also an agent tool's input schema. Every string is one line, so the
 * tool, the CLI and a stored row read alike (a stored row that fails reads as no summary).
 */
export const OrientationSummarySchema = z.object({
  purpose: summaryLine(ORIENT_LIMITS.purposeChars),
  languages: z.array(name()).min(ORIENT_LIMITS.languages.min).max(ORIENT_LIMITS.languages.max),
  stages: z.array(prose()).min(ORIENT_LIMITS.stages.min).max(ORIENT_LIMITS.stages.max),
  keyFiles: z
    .array(z.object({ path: name(), does: prose(), why: prose() }))
    .min(ORIENT_LIMITS.keyFiles.min)
    .max(ORIENT_LIMITS.keyFiles.max),
  concepts: z
    .array(z.object({ name: name(), definition: prose(), where: name() }))
    .min(ORIENT_LIMITS.concepts.min)
    .max(ORIENT_LIMITS.concepts.max),
  gotchas: z.array(prose()).min(ORIENT_LIMITS.gotchas.min).max(ORIENT_LIMITS.gotchas.max),
  exercises: z
    .array(z.object({ file: name(), read: prose(), question: prose() }))
    .length(ORIENT_LIMITS.exercises),
  sources: z.array(name()).min(ORIENT_LIMITS.sources.min).max(ORIENT_LIMITS.sources.max),
});
export type OrientationSummary = z.infer<typeof OrientationSummarySchema>;

/** Whether a listing still matches the file: as written, found elsewhere, edited, or gone. */
export const ListingStateSchema = z.enum(["current", "moved", "changed", "missing"]);
export type ListingState = z.infer<typeof ListingStateSchema>;

export const OrientationBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chapter"), ordinal: z.number(), title: z.string() }),
  z.object({ kind: z.literal("note"), ordinal: z.number(), markdown: z.string() }),
  z.object({
    kind: z.literal("listing"),
    ordinal: z.number(),
    number: z.number(),
    caption: z.string(),
    path: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    text: z.string(),
    ref: z.string().nullable(),
    check: z
      .object({
        state: ListingStateSchema,
        startLine: z.number().nullable(),
        endLine: z.number().nullable(),
        checkedAt: z.number(),
      })
      .nullable(),
  }),
]);
export type OrientationBlock = z.infer<typeof OrientationBlockSchema>;

export const OrientationSchema = z.object({
  id: z.string(),
  status: z.enum(ORIENTATION_STATUSES),
  depth: OrientationDepthSchema,
  title: z.string(),
  summary: OrientationSummarySchema.nullable(),
  blocks: z.number(),
  listings: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  readyAt: z.number().nullable(),
  error: z.string().nullable(),
  headSha: z.string().nullable(),
  workspace: WorkspaceSchema.nullable(),
});
export type Orientation = z.infer<typeof OrientationSchema>;

/** Reads "40" or "40-72" (1-based, start no later than end); null for anything else. */
export function parseLineRange(spec: string): { start: number; end: number } | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) return null;
  return { start, end };
}
