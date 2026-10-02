import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** The most a `SKILL.md` may hold. Real ones run to tens of kilobytes. */
export const MAX_SKILL_BYTES = 1024 * 1024;

const CHUNK_BYTES = 64 * 1024;

/**
 * Reads a text file a workspace may have planted, or null when there is
 * nothing safe to read: it is missing, it is not a regular file, or it holds
 * more than `maxBytes`.
 *
 * Discovery runs whenever a composer's count loads, over files anyone with a
 * checkout can write, so a read must end. A `SKILL.md` that is a FIFO would
 * block it, and one linked to `/dev/zero` would never finish. The file is
 * opened non-blocking (opening a FIFO returns at once), its type is checked
 * on that open descriptor — so what is read is what was checked — and the
 * read stops one chunk past the cap. Symlinks are followed, as the providers
 * follow them.
 */
export async function readBoundedText(filePath: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
