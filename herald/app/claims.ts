/**
 * Which window says a sentence. Windows of one app share an origin, so they
 * share `localStorage` and Web Locks: each announcement is claimed by event id
 * under a lock held only for the check, and the first window to claim it
 * speaks. Nothing is held between announcements, so a window that closed, or a
 * plugin generation the host replaced, can never keep the others quiet.
 *
 * A claim is recoverable: a window whose playback was refused releases it, and
 * every window that lost the claim hears of the release (`onClaimReleased`,
 * the `storage` event the removal fires in every other window of the origin)
 * and tries again — however long the refused attempt took. The announcer also claims only when this window can make a
 * sound unprompted, so an untapped tab does not take a sentence it cannot say.
 *
 * Where storage is unavailable (a private window that refuses it), every
 * window speaks: two voices beat none.
 */

/** How long a claim is kept; an event id never comes back, so this only bounds storage. */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

interface ClaimEnvironment {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length"> | null;
  locks: Pick<LockManager, "request"> | null;
  now: () => number;
}

function browserEnvironment(): ClaimEnvironment {
  let storage: Storage | null = null;
  try {
    storage = typeof window === "undefined" ? null : window.localStorage;
  } catch {
    storage = null;
  }
  const locks = typeof navigator === "undefined" ? null : (navigator.locks ?? null);
  return { storage, locks, now: Date.now };
}

function prune(environment: ClaimEnvironment, prefix: string): void {
  const { storage } = environment;
  if (storage === null) return;
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(prefix)) continue;
    const at = Number(storage.getItem(key));
    if (!Number.isFinite(at) || environment.now() - at > CLAIM_TTL_MS) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
}

/**
 * Calls `listener` with the event id whenever another window gives a claim
 * back. A browser fires `storage` in every other window of the origin when a
 * key is removed, never in the window that removed it.
 */
export function onClaimReleased(prefix: string, listener: (eventId: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key === null || !event.key.startsWith(prefix) || event.newValue !== null) return;
    listener(event.key.slice(prefix.length));
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

export interface Claim {
  /** Gives the announcement back, for another window to say. */
  release(): Promise<void>;
}

const NO_STORAGE_CLAIM: Claim = { release: async () => {} };

/** A claim when this window is the first to claim `eventId`, and so should say it; null when another window has. */
export async function claimAnnouncement(
  prefix: string,
  eventId: string,
  environment: ClaimEnvironment = browserEnvironment(),
): Promise<Claim | null> {
  const { storage, locks } = environment;
  if (storage === null) return NO_STORAGE_CLAIM;
  const key = `${prefix}${eventId}`;
  const token = `${environment.now()}`;
  const underLock = <T>(work: () => T): Promise<T> =>
    locks === null ? Promise.resolve(work()) : (locks.request(key, () => work()) as Promise<T>);
  const won = await underLock(() => {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, token);
    prune(environment, prefix);
    return true;
  });
  if (!won) return null;
  return {
    release: () =>
      underLock(() => {
        if (storage.getItem(key) === token) storage.removeItem(key);
      }),
  };
}
