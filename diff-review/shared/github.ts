/**
 * GitHub pull requests as the plugin names them. No SDK import: the app uses this at run time.
 */
import { z } from "zod";

const ownerSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);

/** A pull request: the `pr` view's whole identity. */
export const pullRefSchema = z.object({ owner: ownerSchema, repo: ownerSchema, number: z.number().int().positive() }).strict();
export type PullRef = z.infer<typeof pullRefSchema>;

/** `https://github.com/<owner>/<repo>/pull/<n>` (anything after the number allowed), or null. */
export function parsePullUrl(text: string): PullRef | null {
  const match = /^\s*(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?\s*$/.exec(text);
  if (match === null) return null;
  const parsed = pullRefSchema.safeParse({ owner: match[1], repo: match[2], number: Number(match[3]) });
  return parsed.success ? parsed.data : null;
}

export function pullUrl(ref: PullRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

export function pullText(ref: PullRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** `owner/repo#n` back to a ref, or null. */
export function parsePullText(text: string): PullRef | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(text);
  if (match === null) return null;
  const parsed = pullRefSchema.safeParse({ owner: match[1], repo: match[2], number: Number(match[3]) });
  return parsed.success ? parsed.data : null;
}

/** What the `pr` view shows of the pull request, from GitHub. */
export const pullDetailsSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    state: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    /** The commits the diff is between, as fetched. */
    headSha: z.string(),
    baseSha: z.string(),
    /** When the review threads were last read from GitHub (epoch ms), or null when they could not be. */
    syncedAt: z.number().nullable(),
    syncError: z.string().nullable(),
  })
  .strict();
export type PullDetails = z.infer<typeof pullDetailsSchema>;

/** The verdict a submitted review carries. */
export const reviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;
