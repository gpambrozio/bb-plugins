/**
 * Dry runs. A repository's first dream, and any dream started with `--dry-run`, works on a copy:
 * `<proposals>/<stamp>/memory/` starts as the memory folder's files, the dream edits the copy as if it
 * were the memory, and the real folder is never written. `base.json` records the `.md` files as they
 * were when the copy was made, and `proposal.json` what the dream changed and its summary.
 *
 * Applying copies over only what the dream changed, and refuses when one of those files has changed
 * in the real folder since (a session wrote to it), so a proposal never undoes newer memory. Files
 * that appeared in the real folder meanwhile stay.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { LOCK_FILE } from "./lock";
import { diffManifests, manifest, stampTime, type Changes, type Manifest } from "./snapshot";

export interface ProposalRecord {
  stamp: string;
  createdAt: number;
  status: "running" | "ready" | "applied" | "discarded" | "failed";
  changes: Changes | null;
  summary: string | null;
  appliedAt: number | null;
}

export interface Proposal extends ProposalRecord {
  dir: string;
  memoryDir: string;
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function proposalOf(dir: string): Proposal | null {
  const record = readJson<ProposalRecord>(path.join(dir, "proposal.json"));
  if (record === null) return null;
  return { ...record, dir, memoryDir: path.join(dir, "memory") };
}

/** Copies the memory folder (without `.git/` and the lock) into a new proposal. */
export function createProposal(memoryDir: string, proposalsDir: string, stamp: string, now = Date.now()): Proposal {
  const dir = path.join(proposalsDir, stamp);
  const copy = path.join(dir, "memory");
  mkdirSync(dir, { recursive: true });
  cpSync(memoryDir, copy, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return name !== ".git" && name !== LOCK_FILE;
    },
  });
  mkdirSync(copy, { recursive: true });
  writeJson(path.join(dir, "base.json"), manifest(memoryDir));
  const record: ProposalRecord = { stamp, createdAt: now, status: "running", changes: null, summary: null, appliedAt: null };
  writeJson(path.join(dir, "proposal.json"), record);
  return { ...record, dir, memoryDir: copy };
}

/** Records how the dream on the copy ended, and what it changed. */
export function finishProposal(proposal: Proposal, ok: boolean, summary: string | null): Proposal {
  const base = readJson<Manifest>(path.join(proposal.dir, "base.json")) ?? {};
  const changes = diffManifests(base, manifest(proposal.memoryDir));
  const record: ProposalRecord = { ...proposal, status: ok ? "ready" : "failed", changes, summary };
  writeJson(path.join(proposal.dir, "proposal.json"), toRecord(record));
  return { ...proposal, ...record };
}

function toRecord(proposal: ProposalRecord): ProposalRecord {
  const { stamp, createdAt, status, changes, summary, appliedAt } = proposal;
  return { stamp, createdAt, status, changes, summary, appliedAt };
}

export function listProposals(proposalsDir: string): Proposal[] {
  let names: string[];
  try {
    names = readdirSync(proposalsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => stampTime(name) !== null)
    .map((name) => proposalOf(path.join(proposalsDir, name)))
    .filter((proposal): proposal is Proposal => proposal !== null)
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/** The newest proposal that waits on the user: ready, neither applied nor discarded. */
export function pendingProposal(proposalsDir: string): Proposal | null {
  return listProposals(proposalsDir).find((proposal) => proposal.status === "ready") ?? null;
}

export function findProposal(proposalsDir: string, stamp: string | undefined): Proposal | null {
  if (stamp === undefined) return pendingProposal(proposalsDir);
  const dir = path.join(proposalsDir, path.basename(stamp));
  return existsSync(dir) ? proposalOf(dir) : null;
}

export class ProposalConflictError extends Error {
  constructor(readonly files: string[]) {
    super(`These memory files changed since the dry run, so applying it would undo that: ${files.join(", ")}. Discard it and dream again.`);
  }
}

/** What applying would change in the real folder, or a conflict. Writes nothing. */
export function planApply(proposal: Proposal, memoryDir: string): Changes {
  if (proposal.status !== "ready") throw new Error(`The proposal from ${proposal.stamp} is ${proposal.status}, not ready to apply.`);
  const base = readJson<Manifest>(path.join(proposal.dir, "base.json"));
  if (base === null) throw new Error(`The proposal from ${proposal.stamp} has no base.json.`);
  const proposed = manifest(proposal.memoryDir);
  const current = manifest(memoryDir);
  const changes = diffManifests(base, proposed);
  const conflicts = [...changes.added, ...changes.changed, ...changes.deleted].filter((file) => current[file] !== base[file]);
  if (conflicts.length > 0) throw new ProposalConflictError(conflicts);
  return changes;
}

/** Applies a planned proposal to the real folder. The caller takes a backup first. */
export function applyProposal(proposal: Proposal, memoryDir: string, changes: Changes, now = Date.now()): void {
  for (const file of [...changes.added, ...changes.changed]) {
    const target = path.join(memoryDir, ...file.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.dream-${process.pid}`;
    cpSync(path.join(proposal.memoryDir, ...file.split("/")), temporary);
    renameSync(temporary, target);
  }
  for (const file of changes.deleted) rmSync(path.join(memoryDir, ...file.split("/")), { force: true });
  writeJson(path.join(proposal.dir, "proposal.json"), toRecord({ ...proposal, status: "applied", appliedAt: now }));
}

export function discardProposal(proposal: Proposal): void {
  writeJson(path.join(proposal.dir, "proposal.json"), toRecord({ ...proposal, status: "discarded" }));
}
