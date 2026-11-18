/**
 * `<memory>/.consolidate-lock`, with Claude Code 2.1.326's semantics (its auto-dream lock), so a
 * native dream and this plugin agree on when the last dream was and do not dream the same memory at
 * once:
 *
 * - its body is the holder's PID while a dream runs;
 * - its mtime is when the memory was last consolidated (0 when there is no lock);
 * - it is held while its mtime is under an hour old *and* its PID is alive; otherwise it is stale and
 *   may be taken;
 * - on failure the mtime is set back to what it was, or the file is removed when there was none, so a
 *   failed dream does not count as one. A successful dream leaves the PID and the mtime it was taken at.
 *
 * Native takes the lock by writing its PID and reading it back. That alone is not exclusive: two
 * processes that both saw a stale lock can each write and read back their own PID. So this plugin
 *
 * 1. checks and writes only while holding `<lock>.claim`, created with O_EXCL, which no two plugin
 *    processes can hold at once (a claim older than `CLAIM_STALE_MS` is a crashed holder's and is
 *    broken);
 * 2. after writing, waits `settleMs` and reads the lock again. Native writes then reads back at once,
 *    so a native dream that raced it has rewritten the PID by then, and the plugin gives up. The race
 *    with native is narrowed to native's own read-back window, not closed: native does not take the
 *    claim.
 *
 * Every later change (rollback, marking a time) first checks that the lock still holds this PID, so
 * the plugin never resets a lock another process has taken since.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LOCK_FILE = ".consolidate-lock";
export const LOCK_STALE_MS = 3_600_000;
export const CLAIM_STALE_MS = 30_000;
/** How long after writing its PID the plugin reads the lock again. */
export const SETTLE_MS = 750;

export type IsAlive = (pid: number) => boolean;

/** `process.kill(pid, 0)`: alive unless the process does not exist (EPERM means it does). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockPath(memoryDir: string): string {
  return path.join(memoryDir, LOCK_FILE);
}

interface LockFile {
  mtimeMs: number;
  pid: number | undefined;
}

function readLock(memoryDir: string): LockFile | null {
  const file = lockPath(memoryDir);
  try {
    const mtimeMs = statSync(file).mtimeMs;
    let pid: number | undefined;
    try {
      const parsed = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      pid = Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      pid = undefined;
    }
    return { mtimeMs, pid };
  } catch {
    return null;
  }
}

/** When the memory was last consolidated: the lock's mtime, or 0. */
export function lastConsolidatedAt(memoryDir: string): number {
  return readLock(memoryDir)?.mtimeMs ?? 0;
}

function heldBy(lock: LockFile | null, isAlive: IsAlive, now: number): boolean {
  return lock !== null && now - lock.mtimeMs < LOCK_STALE_MS && lock.pid !== undefined && isAlive(lock.pid);
}

export function lockState(memoryDir: string, isAlive: IsAlive = processIsAlive, now = Date.now()): { lastConsolidatedAt: number; held: boolean; pid: number | null } {
  const lock = readLock(memoryDir);
  if (lock === null) return { lastConsolidatedAt: 0, held: false, pid: null };
  return { lastConsolidatedAt: lock.mtimeMs, held: heldBy(lock, isAlive, now), pid: lock.pid ?? null };
}

/** Takes `<lock>.claim` with O_EXCL; answers its release, or null when another process holds it. */
export function takeClaim(memoryDir: string, now = Date.now()): (() => void) | null {
  const claim = `${lockPath(memoryDir)}.claim`;
  mkdirSync(memoryDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(claim, "wx"));
      return () => {
        try {
          unlinkSync(claim);
        } catch {
          // Broken by another process as stale; nothing to release.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (now - statSync(claim).mtimeMs < CLAIM_STALE_MS) return null;
        unlinkSync(claim);
      } catch {
        // Released meanwhile; try again.
      }
    }
  }
  return null;
}

export interface AcquireOptions {
  isAlive?: IsAlive;
  now?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Takes the lock for `pid`. Answers the mtime it had before (0 when there was none), for a rollback,
 * or null when a live holder has it, another plugin process holds the claim, or another writer
 * replaced this PID while it settled.
 */
export async function acquireLock(memoryDir: string, pid: number, options: AcquireOptions = {}): Promise<number | null> {
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? Date.now();
  const release = takeClaim(memoryDir, now);
  if (release === null) return null;
  let prior: number;
  try {
    const before = readLock(memoryDir);
    if (heldBy(before, isAlive, now)) return null;
    const file = lockPath(memoryDir);
    writeFileSync(file, String(pid));
    // The write already sets the mtime to now; setting it to the caller's clock keeps the two the same.
    utimesSync(file, now / 1000, now / 1000);
    prior = before?.mtimeMs ?? 0;
  } finally {
    release();
  }
  await (options.sleep ?? wait)(options.settleMs ?? SETTLE_MS);
  return readLock(memoryDir)?.pid === pid ? prior : null;
}

/** Whether the lock still names `pid` (or is empty after this process marked it). */
export function ownsLock(memoryDir: string, pid: number): boolean {
  const lock = readLock(memoryDir);
  if (lock === null) return false;
  return lock.pid === pid;
}

/**
 * Puts the mtime back to `priorMtimeMs`, or removes the lock when it had none, if the lock still holds
 * `pid`. Answers false, changing nothing, when another process has taken it since.
 */
export function rollbackLock(memoryDir: string, priorMtimeMs: number, pid: number): boolean {
  if (!ownsLock(memoryDir, pid)) return false;
  const file = lockPath(memoryDir);
  if (priorMtimeMs === 0) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return true;
  }
  writeFileSync(file, "");
  const seconds = priorMtimeMs / 1000;
  utimesSync(file, seconds, seconds);
  return true;
}

/**
 * Marks the memory consolidated at `atMs` with no holder, if the lock holds `pid`: what applying or
 * discarding a dry run does once it has taken the lock.
 */
export function markConsolidated(memoryDir: string, atMs: number, pid: number): boolean {
  if (!ownsLock(memoryDir, pid)) return false;
  const file = lockPath(memoryDir);
  writeFileSync(file, "");
  const seconds = atMs / 1000;
  utimesSync(file, seconds, seconds);
  return true;
}
