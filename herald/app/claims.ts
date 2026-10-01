/**
 * Which window says a sentence. Windows of one app share an origin, so they
 * share `localStorage` and Web Locks: each announcement is claimed by event id
 * under a lock held only for the check, and the first window to claim it
 * speaks. Nothing is held between announcements, so a window that closed, or a
 * plugin generation the host replaced, can never keep the others quiet.
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

/** True when this window is the first to claim `eventId`, and so should say it. */
export async function claimAnnouncement(
  prefix: string,
  eventId: string,
  environment: ClaimEnvironment = browserEnvironment(),
): Promise<boolean> {
  const { storage, locks } = environment;
  if (storage === null) return true;
  const key = `${prefix}${eventId}`;
  const check = (): boolean => {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, String(environment.now()));
    prune(environment, prefix);
    return true;
  };
  if (locks === null) return check();
  return locks.request(key, () => check());
}
