/**
 * Where the Reviews page shows one review: `<bb thread>/<view>[/<file>]`. The view (and the file) may
 * hold a `/` (a branch name, a path), so each is encoded once more: bb encodes each segment it is
 * given and the page decodes each segment once. No SDK import: the app uses this at run time.
 */
import { targetSchema, type Target } from "./types";

export const REVIEWS_PATH = "reviews";

/** The realtime channel `bb diff-review open` asks the windows to open a review on. */
export const OPEN_CHANNEL = "open-review";

export interface ReviewAddress {
  threadId: string;
  target: Target;
  /** A file of the view to go to. */
  file?: string | null;
}

export function reviewSubPath(address: ReviewAddress): string {
  const parts = [address.threadId, encodeURIComponent(JSON.stringify(address.target))];
  if (address.file !== undefined && address.file !== null) parts.push(encodeURIComponent(address.file));
  return parts.join("/");
}

/** The page's route, as a link to it reads (each segment percent-encoded, as bb's router keeps them). */
export function reviewRoute(pluginId: string, address: ReviewAddress): string {
  return `/plugins/${pluginId}/${REVIEWS_PATH}/${reviewSubPath(address).split("/").map(encodeURIComponent).join("/")}`;
}

/** The review a subPath names, or null for the page's list. `subPath` arrives percent-encoded per segment. */
export function parseReviewSubPath(subPath: string): { threadId: string; target: Target; file: string | null } | null {
  const [thread, view, file, ...rest] = subPath.split("/");
  if (thread === undefined || view === undefined || rest.length > 0 || thread === "") return null;
  try {
    const target = targetSchema.safeParse(JSON.parse(decodeURIComponent(decodeURIComponent(view))));
    if (!target.success) return null;
    return { threadId: decodeURIComponent(thread), target: target.data, file: file === undefined || file === "" ? null : decodeURIComponent(decodeURIComponent(file)) };
  } catch {
    return null;
  }
}

/** What `bb diff-review open` publishes on `OPEN_CHANNEL`. */
export function openRequest(value: unknown): ReviewAddress | null {
  if (typeof value !== "object" || value === null) return null;
  const { threadId, target, file } = value as { threadId?: unknown; target?: unknown; file?: unknown };
  const parsed = targetSchema.safeParse(target);
  if (typeof threadId !== "string" || threadId === "" || !parsed.success) return null;
  return { threadId, target: parsed.data, file: typeof file === "string" && file !== "" ? file : null };
}
