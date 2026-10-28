/**
 * The card a thread was started on, read back from the thread's plugin
 * metadata (`send` stores `{ card }` there). Pure, so the Info tab row and the
 * sidebar row item share it and their tests need no host.
 */
import { SentCardSchema } from "../shared/schemas";

/**
 * Only what the two surfaces draw. Read with a narrower schema than the one
 * `send` writes, so a thread started by an older or newer board, whose card
 * carries other fields, still shows its card.
 */
const ThreadCardSchema = SentCardSchema.pick({ repository: true, number: true, title: true, url: true });

export type ThreadCard = {
  repository: string;
  number: number;
  title: string;
  url: string;
};

/** The card in a thread's metadata for this plugin, or null when it has none. */
export function cardFromMetadata(metadata: unknown): ThreadCard | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const parsed = ThreadCardSchema.safeParse((metadata as { card?: unknown }).card);
  return parsed.success ? parsed.data : null;
}

/** `owner/repo#123`, as GitHub writes a reference. */
export function cardReference(card: ThreadCard): string {
  return `${card.repository}#${card.number}`;
}

/** `experimental_listPluginMetadata` reads at most this many threads per call. */
export const METADATA_BATCH = 200;

/** `ids` in runs of at most `size`, in order. */
export function batches<T>(ids: readonly T[], size: number = METADATA_BATCH): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < ids.length; start += size) out.push(ids.slice(start, start + size));
  return out;
}

/**
 * The threads whose card is still to be read: those this plugin started
 * (bb stamps `originPluginId` on a thread spawned with plugin metadata), that
 * have not been read yet and are not being read now. A thread the board did
 * not start carries no card, so it costs no request.
 */
export function threadsToRead(
  threads: readonly { id: string; originPluginId: string | null }[],
  pluginId: string,
  known: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const thread of threads) {
    if (thread.originPluginId === pluginId && !known.has(thread.id)) ids.push(thread.id);
  }
  return ids;
}
