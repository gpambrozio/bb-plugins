/**
 * The staged edit of the voice's own instructions (`shared/prompt-edit.ts`). The voice stages one with its
 * `propose_instructions_edit` tool; only the owner, on the Voice page, applies it (as staged, or tweaked) or
 * rejects it. It lives in the plugin's storage (`bb.storage.kv`), one at a time: a new one replaces the one
 * waiting and says so. Applying writes the **Instructions** setting, which each session reads once, as it
 * starts, so the session in progress keeps its instructions and the next one gets the new ones.
 *
 * Stage, apply and reject each read, change and write the one stored edit across several awaits, so they run
 * one at a time: an Apply clicked while the voice stages a replacement would otherwise delete the replacement
 * unreviewed. Across a reload two copies of the plugin are loaded for a moment, and the queue is per copy, so
 * apply and reject also delete the stored edit only while it is still the one they acted on.
 */
import { randomUUID } from "node:crypto";

import { PROMPT_MAX, StagedEditSchema, applyChanges, type PromptChange, type StagedEdit } from "../shared/prompt-edit";
import type { Clock, Log } from "./ports";

export const STAGED_KEY = "staged-instructions-edit";

export interface PromptEditsDeps {
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
  /** The Instructions setting: `get` gives the instructions in force (the default for a blank setting). */
  instructions: { get(): Promise<string>; set(text: string): Promise<void> };
  clock: Pick<Clock, "now">;
  log: Pick<Log, "info" | "warn">;
  /** The staged edit changed: the app reads it again. */
  changed(): void;
  newId?: () => string;
}

/** What the voice asks for: the whole new text, or changes to make to the current one. */
export type StageRequest = { summary: string } & ({ text: string; changes?: undefined } | { changes: PromptChange[]; text?: undefined });

export interface StageResult {
  staged: StagedEdit;
  /** The edit this one replaced; null when none was waiting. */
  replaced: StagedEdit["replaced"];
}

export class PromptEdits {
  private readonly newId: () => string;
  /** The change in progress, and those queued behind it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PromptEditsDeps) {
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /** The staged edit, or null; one stored in a shape this version cannot read is dropped with a warning. */
  async staged(): Promise<StagedEdit | null> {
    const stored = await this.deps.kv.get<unknown>(STAGED_KEY);
    if (stored === undefined) return null;
    const parsed = StagedEditSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    this.deps.log.warn("Dropped a staged instructions edit that could not be read.");
    await this.deps.kv.delete(STAGED_KEY);
    return null;
  }

  async read(): Promise<{ staged: StagedEdit | null; current: string }> {
    return { staged: await this.staged(), current: await this.deps.instructions.get() };
  }

  /** Stages an edit for the owner's review, replacing any edit waiting. Never touches the setting. */
  async stage(request: StageRequest): Promise<StageResult> {
    return this.inTurn(() => this.stageNow(request));
  }

  private async stageNow(request: StageRequest): Promise<StageResult> {
    const summary = request.summary.trim();
    if (summary === "") throw new Error("Say in a few words what the edit changes, as the summary.");
    const base = await this.deps.instructions.get();
    const proposed = request.text !== undefined ? request.text : applyChanges(base, request.changes);
    if (proposed.trim() === "") throw new Error("The instructions cannot be empty.");
    if (proposed.length > PROMPT_MAX) throw new Error(`The instructions would be longer than ${PROMPT_MAX} characters.`);
    if (proposed === base) throw new Error("That edit changes nothing in the instructions.");
    const previous = await this.staged();
    const replaced = previous === null ? null : { summary: previous.summary, stagedAt: previous.stagedAt };
    const staged: StagedEdit = { id: this.newId(), proposed, base, summary: summary.slice(0, 300), stagedAt: this.deps.clock.now(), replaced };
    await this.deps.kv.set(STAGED_KEY, staged);
    this.deps.log.info(replaced === null ? "Staged an instructions edit for review." : "Staged an instructions edit for review, replacing the one waiting.");
    this.deps.changed();
    return { staged, replaced };
  }

  /** Applies staged edit `id`: its text, or the owner's tweak of it. The next session starts with it. */
  async apply(id: string, tweaked?: string): Promise<void> {
    return this.inTurn(() => this.applyNow(id, tweaked));
  }

  private async applyNow(id: string, tweaked?: string): Promise<void> {
    const staged = await this.waiting(id);
    const text = tweaked ?? staged.proposed;
    if (text.trim() === "") throw new Error("The instructions cannot be empty. To go back to the default, clear the Instructions setting.");
    await this.deps.instructions.set(text);
    await this.drop(id);
    this.deps.log.info(tweaked === undefined || tweaked === staged.proposed ? "Applied the staged instructions edit." : "Applied the staged instructions edit, as the owner tweaked it.");
    this.deps.changed();
  }

  /** Drops staged edit `id`; the instructions stay as they are. */
  async reject(id: string): Promise<void> {
    return this.inTurn(() => this.rejectNow(id));
  }

  private async rejectNow(id: string): Promise<void> {
    await this.waiting(id);
    await this.drop(id);
    this.deps.log.info("Rejected the staged instructions edit.");
    this.deps.changed();
  }

  /** Runs `work` once every change queued before it has settled. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Deletes the stored edit if it is still `id`: one staged meanwhile, by the other copy during a reload, stays. */
  private async drop(id: string): Promise<void> {
    const stored = await this.staged();
    if (stored?.id !== id) {
      this.deps.log.warn("A newer instructions edit was staged meanwhile; it stays for review.");
      return;
    }
    await this.deps.kv.delete(STAGED_KEY);
  }

  /** The staged edit when it is still `id`: one replaced since the owner looked is never applied or dropped blind. */
  private async waiting(id: string): Promise<StagedEdit> {
    const staged = await this.staged();
    if (staged === null) throw new Error("No instructions edit is waiting: it was applied or rejected already.");
    if (staged.id !== id) throw new Error("A newer instructions edit replaced this one. Review the new one.");
    return staged;
  }
}
