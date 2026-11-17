/**
 * `<memory>/.consolidate-lock`, with Claude Code 2.1.326's semantics (its auto-dream lock), so a
 * native dream and this plugin's never run on the same memory at once and agree on when the last one
 * was:
 *
 * - its body is the holder's PID while a dream runs;
 * - its mtime is when the memory was last consolidated (0 when there is no lock);
 * - it is held while its mtime is under an hour old *and* its PID is alive; otherwise it is stale and
 *   may be taken;
 * - taking it writes the PID and reads it back, so of two takers only one sees its own PID;
 * - on failure the mtime is set back to what it was, or the file is removed when there was none, so a
 *   failed dream does not count as one.
 *
 * A successful dream leaves the lock as it is: the PID in the body and the mtime of the moment it was
 * taken, as native does.
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LOCK_FILE = ".consolidate-lock";
export const LOCK_STALE_MS = 3_600_000;

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

export function lockState(memoryDir: string, isAlive: IsAlive = processIsAlive, now = Date.now()): { lastConsolidatedAt: number; held: boolean; pid: number | null } {
  const lock = readLock(memoryDir);
  if (lock === null) return { lastConsolidatedAt: 0, held: false, pid: null };
  const held = now - lock.mtimeMs < LOCK_STALE_MS && lock.pid !== undefined && isAlive(lock.pid);
  return { lastConsolidatedAt: lock.mtimeMs, held, pid: lock.pid ?? null };
}

/**
 * Takes the lock for `pid`. Answers the mtime it had before (0 when there was none), for a rollback,
 * or null when a live holder has it or another taker won.
 */
export function acquireLock(memoryDir: string, pid: number, isAlive: IsAlive = processIsAlive, now = Date.now()): number | null {
  const before = readLock(memoryDir);
  if (before !== null && now - before.mtimeMs < LOCK_STALE_MS && before.pid !== undefined && isAlive(before.pid)) return null;
  mkdirSync(memoryDir, { recursive: true });
  const file = lockPath(memoryDir);
  writeFileSync(file, String(pid));
  // The write already sets the mtime to now; setting it to the caller's clock keeps the two the same.
  utimesSync(file, now / 1000, now / 1000);
  let readBack: string;
  try {
    readBack = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (Number.parseInt(readBack.trim(), 10) !== pid) return null;
  return before?.mtimeMs ?? 0;
}

/** Puts the mtime back to `priorMtimeMs`, or removes the lock when it had none. */
export function rollbackLock(memoryDir: string, priorMtimeMs: number): void {
  const file = lockPath(memoryDir);
  if (priorMtimeMs === 0) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  writeFileSync(file, "");
  const seconds = priorMtimeMs / 1000;
  utimesSync(file, seconds, seconds);
}

/** Marks the memory consolidated at `atMs` with no holder: what applying a dry run's proposal does. */
export function markConsolidated(memoryDir: string, atMs: number): void {
  mkdirSync(memoryDir, { recursive: true });
  const file = lockPath(memoryDir);
  writeFileSync(file, "");
  const seconds = atMs / 1000;
  utimesSync(file, seconds, seconds);
}
