/**
 * Repo orientations (spec §6, §7, §8): starting a build in a hidden builder thread, the builder's writes
 * (chapters, notes, listings, the summary, finish), and Cancel, Delete, Verify and Export from the tab.
 *
 * ```
 * starting → building → ready
 *     │          │
 *     └──────────┴─→ failed | cancelled
 * ```
 *
 * Reserve, then spawn: under the project's lock a `starting` row is inserted with no await between the
 * check and the insert (a partial unique index refuses a second live row whatever races), then bb is asked
 * for the hidden thread. The builder may call before `spawn` answers; its first call binds it by the
 * orientation id bb stamped on its metadata, only when this plugin started that thread (`builderFor`).
 *
 * Every builder write runs under the orientation's lock and re-reads the row after each await, so nothing
 * lands on a row that left `starting`/`building` meanwhile (the store's `updated_at` drives the purge of
 * old failed rows, so a terminal row is never touched). A builder is put away (stopped, then archived) on
 * finish and cancel; those errors are logged, never thrown into the user's action. After `dispose()` no
 * continuation of this copy touches the store (`alive()`).
 *
 * Reload safety (finding builders a reload interrupted) is `reconcile`, added beside this; until it has
 * run, `clean` keeps starts refused.
 */
import { LIVE_ORIENTATION_STATUSES, ORIENT_LIMITS, OrientationSummarySchema, parseLineRange, type OrientationDepth, type OrientationStatus } from "../shared/orientation";
import { PLUGIN_ID } from "../shared/types";
import { workspacePath } from "../shared/workspace-path";
import { buildBuilderBrief, builderStartLine } from "./content";
import { renderOrientationMarkdown } from "./orientation-markdown";
import type { BlockRow, OrientationRow, OrientationStore } from "./orientation-store";
import { checkListing, sha256, sliceLines } from "./orientation-verify";
import { canStartByHand, projectKey } from "./policy";
import { FileConflict, type FileRead, type FileRoot, type Ports } from "./ports";
import type { LearningSettings } from "./settings";
import { newId } from "./store";

/** The plugin metadata key a builder thread carries its orientation's id under. */
export const ORIENTATION_METADATA_KEY = "orientation";

/** A refusal the agent or the user should read as it is. */
export class OrientationError extends Error {}

const NOT_BUILDING = "This thread is not building an orientation.";
const OUTSIDE = "That path is outside the workspace.";
const SUMMARY_ONLY =
  "This is a summary-only orientation: it has no chapters, notes or listings. Set the summary with orient_summary, then call orient_finish.";

/** A fenced code block's opening line (CommonMark: up to three spaces, then three backticks or tildes). */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/m;
/** A line that is only a Markdown image, which showboat would read as an image block on export. */
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/m;
/** A listing named in prose, as the finish check and the reader's links read it. */
const LISTING_REF = /\bListing (\d+)\b/g;

type ListingRow = Extract<BlockRow, { kind: "listing" }>;

function isLive(status: OrientationStatus): boolean {
  return (LIVE_ORIENTATION_STATUSES as readonly OrientationStatus[]).includes(status);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lines in a text as `sliceLines` counts them: a final newline ends the last line, it does not start one. */
function lineCount(text: string): number {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** `text` in a fence one backtick longer than its longest backtick run, at least three. */
function fenced(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * A path as Markdown inline code that nothing in it can end or break: control characters become `?`,
 * and the delimiter outruns any backticks inside. Drift lines are placed unquoted in a session brief, so
 * the path is the only repo-derived text they carry, and it stays inside its code span.
 */
function codeSpan(text: string): string {
  const plain = text.replace(/\p{Cc}/gu, "?");
  let longest = 0;
  for (const run of plain.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const tick = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${tick}${pad}${plain}${pad}${tick}`;
}

/** One line per listing that no longer matches its file: `Listing N (`path:A-B`) moved to C-D` and so on. */
function driftLine(listing: ListingRow): string | null {
  const check = listing.check;
  if (check === null || check.state === "current") return null;
  const where = `Listing ${listing.number} (${codeSpan(`${listing.path}:${listing.startLine}-${listing.endLine}`)})`;
  if (check.state === "moved") return `${where} moved to ${check.startLine}-${check.endLine}`;
  if (check.state === "changed") return `${where} changed since ${listing.ref === null ? "capture" : listing.ref.slice(0, 7)}`;
  return `${where} missing`;
}

/** Why a read gave no text, as the builder reads it; null for text. */
function unreadable(read: FileRead | null, path: string): string | null {
  const name = codeSpan(path);
  if (read === null) return `Could not read ${name}; try again.`;
  if (read.kind === "missing") return `${name} does not exist in the workspace.`;
  if (read.kind === "binary") return `${name} is not a text file.`;
  if (read.kind === "too-large") return `${name} is larger than 1 MiB.`;
  return null;
}

/** One line of text for a heading: trimmed, non-empty, single-line, within `max`. */
function oneLine(value: string, what: string, max: number): string {
  const text = value.trim();
  if (text === "") throw new OrientationError(`The ${what} is empty.`);
  if (/[\r\n]/.test(text)) throw new OrientationError(`A ${what} is one line.`);
  if (text.length > max) throw new OrientationError(`The ${what} is ${text.length} characters; the most is ${max}.`);
  return text;
}

export class OrientationService {
  /** Set when this copy of the plugin goes: its store and its `bb` handle are closed from then on. */
  private disposed = false;
  /** False while builders an earlier copy left may still be running; starts are refused meanwhile. */
  private clean = true;
  /** The tail of each key's queue (`exclusive`). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ports: Ports,
    private readonly store: OrientationStore,
    private readonly settings: () => LearningSettings,
  ) {}

  /** Runs `work` after every earlier call with the same key has settled. */
  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /** Throws when this copy of the plugin was disposed while it awaited. */
  private alive(): void {
    if (this.disposed) throw new OrientationError("Learning Exercises reloaded while this was running. Try again.");
  }

  private warn(message: string): void {
    if (this.disposed) return;
    try {
      this.ports.warn(message);
    } catch {
      // The log is gone with this copy of the plugin.
    }
  }

  // ── start ─────────────────────────────────────────────────────────────────

  async start(input: { sourceThreadId: string; depth: OrientationDepth }): Promise<{ orientationId: string }> {
    const source = await this.ports.thread(input.sourceThreadId);
    this.alive();
    if (source === null) throw new OrientationError("That thread is gone.");
    const project = await this.ports.project(source.projectId);
    this.alive();
    const key = projectKey(project ?? { id: source.projectId, gitRemoteUrl: null });
    const projectName = project?.name ?? source.projectId;
    return this.exclusive(`orient:${key}`, async () => {
      if (!this.clean) throw new OrientationError("Cleaning up an earlier build; try again shortly.");
      if (!canStartByHand(source)) throw new OrientationError("Orientations start only from a thread you can see, and never from one of this plugin's own threads.");
      const environmentId = source.environmentId;
      if (environmentId === null) throw new OrientationError("This thread has no checkout to orient in.");
      const root = await this.ports.environmentRoot(environmentId);
      this.alive();
      if (root === null) throw new OrientationError("This thread's checkout cannot be reached.");
      const headSha = await this.ports.headSha(environmentId);
      this.alive();
      return this.reserveAndSpawn({ key, projectName, depth: input.depth, source, environmentId, root, headSha });
    });
  }

  private async reserveAndSpawn(input: {
    key: string;
    projectName: string;
    depth: OrientationDepth;
    source: { id: string; projectId: string; providerId: string };
    environmentId: string;
    root: FileRoot;
    headSha: string | null;
  }): Promise<{ orientationId: string }> {
    const already = "An orientation is already being built for this project.";
    // Checked and created with no await between them; the unique index refuses a second live row even
    // from another copy of the plugin.
    if (this.store.live(input.key) !== null) throw new OrientationError(already);
    let row: OrientationRow;
    try {
      row = this.store.create({
        id: newId("ori"),
        projectKey: input.key,
        projectId: input.source.projectId,
        depth: input.depth,
        sourceThreadId: input.source.id,
        environmentId: input.environmentId,
        hostId: input.root.hostId,
        workspacePath: input.root.rootPath,
        providerId: input.source.providerId,
        headSha: input.headSha,
        title: `Repo Orientation: ${input.projectName}`,
        createdAt: this.ports.now(),
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new OrientationError(already);
      throw error;
    }
    this.ports.changed();
    let threadId: string;
    try {
      ({ threadId } = await this.ports.spawn({
        projectId: input.source.projectId,
        environmentId: input.environmentId,
        providerId: input.source.providerId,
        title: `Orientation builder: ${input.projectName}`,
        hidden: true,
        visible: builderStartLine(input.projectName, input.depth),
        agentOnly: buildBuilderBrief({ depth: input.depth, projectName: input.projectName }),
        metadata: { [ORIENTATION_METADATA_KEY]: row.id },
      }));
    } catch (error) {
      this.alive();
      const message = `Could not start the orientation builder: ${errorText(error)}`;
      this.store.transition(row.id, ["starting"], "failed", this.ports.now(), message);
      this.ports.changed();
      throw new OrientationError(message);
    }
    // Reloaded meanwhile: the new copy's reconcile finds the thread by its metadata.
    this.alive();
    const current = this.store.get(row.id);
    if (current === null || !isLive(current.status)) {
      // Cancelled (or failed) while bb spawned it. A builder that bound itself was put away by whoever
      // ended the row; one that never called is put away here.
      if (current?.builderThreadId !== threadId) await this.putAway(threadId);
      return { orientationId: row.id };
    }
    // Unless the builder bound itself on an early call.
    if (current.builderThreadId === null && this.store.bindBuilder(row.id, threadId, this.ports.now())) {
      this.store.transition(row.id, ["starting"], "building", this.ports.now());
    }
    this.ports.changed();
    return { orientationId: row.id };
  }

  // ── the builder ───────────────────────────────────────────────────────────

  /**
   * The live orientation a thread builds. A builder can call before `spawn` answered, so a `starting` or
   * `building` row with no builder yet is bound to a thread whose metadata names it, when this plugin
   * started that thread (another plugin could stamp the same key).
   */
  async builderFor(threadId: string): Promise<OrientationRow> {
    const bound = this.store.byBuilder(threadId);
    if (bound !== null) {
      if (isLive(bound.status)) return bound;
      throw new OrientationError(NOT_BUILDING);
    }
    const orientationId = await this.ports.metadataValue(threadId, ORIENTATION_METADATA_KEY);
    this.alive();
    if (orientationId === null) throw new OrientationError(NOT_BUILDING);
    const info = await this.ports.thread(threadId);
    this.alive();
    if (info === null || info.originPluginId !== PLUGIN_ID) throw new OrientationError(NOT_BUILDING);
    const row = this.store.get(orientationId);
    if (row === null || !isLive(row.status) || row.builderThreadId !== null) throw new OrientationError(NOT_BUILDING);
    if (!this.store.bindBuilder(row.id, threadId, this.ports.now())) throw new OrientationError(NOT_BUILDING);
    this.store.transition(row.id, ["starting"], "building", this.ports.now());
    this.ports.changed();
    return this.store.get(row.id)!;
  }

  /**
   * Runs one builder write under the orientation's lock, on the row as it is once the lock is held.
   * `work` must call `this.live(id, threadId)` again after each await before it writes.
   */
  private async asBuilder(threadId: string, work: (row: OrientationRow) => Promise<string>): Promise<string> {
    const found = await this.builderFor(threadId);
    return this.exclusive(`orientation:${found.id}`, async () => {
      return work(this.live(found.id, threadId));
    });
  }

  /** The row, still live and still built by `threadId`; refuses otherwise. */
  private live(id: string, threadId: string): OrientationRow {
    this.alive();
    const row = this.store.get(id);
    if (row === null || !isLive(row.status) || row.builderThreadId !== threadId) throw new OrientationError(NOT_BUILDING);
    return row;
  }

  private walkthroughOnly(row: OrientationRow): void {
    if (row.depth === "summary") throw new OrientationError(SUMMARY_ONLY);
  }

  chapter(threadId: string, title: string): Promise<string> {
    return this.asBuilder(threadId, async (row) => {
      this.walkthroughOnly(row);
      const text = oneLine(title, "chapter title", ORIENT_LIMITS.chapterChars);
      this.store.appendChapter(row.id, text, this.ports.now());
      this.ports.changed();
      return `Chapter added: ${text}.`;
    });
  }

  note(threadId: string, markdown: string): Promise<string> {
    return this.asBuilder(threadId, async (row) => {
      this.walkthroughOnly(row);
      const text = markdown.trim();
      if (text === "") throw new OrientationError("The note is empty.");
      if (text.length > ORIENT_LIMITS.noteChars) throw new OrientationError(`The note is ${text.length} characters; the most is ${ORIENT_LIMITS.noteChars}. Split it.`);
      if (FENCE.test(text)) throw new OrientationError('A note may not contain a fenced code block. Show code with orient_listing and refer to it as "Listing N".');
      if (IMAGE_LINE.test(text)) throw new OrientationError("A note may not have a line that is only an image: orientations keep no images, and an export would read that line as one.");
      this.store.appendNote(row.id, text, this.ports.now());
      this.ports.changed();
      return `Note added (${text.length} characters).`;
    });
  }

  listing(threadId: string, input: { path: string; lines: string; caption: string }): Promise<string> {
    return this.asBuilder(threadId, async (row) => {
      this.walkthroughOnly(row);
      const path = workspacePath(input.path.trim());
      if (path === null) throw new OrientationError(OUTSIDE);
      const range = parseLineRange(input.lines.trim());
      if (range === null) throw new OrientationError(`"${input.lines}" is not a line range; use "40-72" or "40".`);
      const length = range.end - range.start + 1;
      if (length > ORIENT_LIMITS.listingLines) throw new OrientationError(`That is ${length} lines; a listing holds at most ${ORIENT_LIMITS.listingLines}. Split it.`);
      const caption = oneLine(input.caption, "caption", ORIENT_LIMITS.captionChars);
      if (this.store.counts(row.id).listings >= ORIENT_LIMITS.listings) throw new OrientationError(`This orientation has ${ORIENT_LIMITS.listings} listings, the most it can hold.`);
      const root = row.environmentId === null ? null : await this.ports.environmentRoot(row.environmentId);
      this.live(row.id, threadId);
      if (root === null) throw new OrientationError("The orientation's checkout cannot be reached.");
      const read = await this.ports.readFile(root, path);
      this.live(row.id, threadId);
      const problem = unreadable(read, path);
      if (problem !== null || read?.kind !== "text") throw new OrientationError(problem ?? `Could not read ${codeSpan(path)}.`);
      const text = sliceLines(read.text, range.start, range.end);
      if (text === null) throw new OrientationError(`${codeSpan(path)} has only ${lineCount(read.text)} lines.`);
      const block = this.store.appendListing(row.id, { caption, path, startLine: range.start, endLine: range.end, text, sha256: sha256(text), ref: row.headSha }, this.ports.now());
      this.ports.changed();
      const number = block.kind === "listing" ? block.number : 0;
      return `Listing ${number} captured (${path}:${range.start}-${range.end}):\n\n${fenced(text)}`;
    });
  }

  pop(threadId: string): Promise<string> {
    return this.asBuilder(threadId, async (row) => {
      const removed = this.store.pop(row.id, this.ports.now());
      if (removed === null) return "There is nothing to remove.";
      this.ports.changed();
      if (removed.kind === "chapter") return `Removed the chapter "${removed.title}".`;
      if (removed.kind === "note") return `Removed a note that began: ${removed.markdown.slice(0, 80)}`;
      return `Removed Listing ${removed.number} (${removed.path}:${removed.startLine}-${removed.endLine}). Its number is not used again.`;
    });
  }

  summary(threadId: string, value: unknown): Promise<string> {
    return this.asBuilder(threadId, async (row) => {
      const parsed = OrientationSummarySchema.safeParse(value);
      if (!parsed.success) {
        const reasons = parsed.error.issues.map((issue) => `- ${issue.path.length === 0 ? "summary" : issue.path.join(".")}: ${issue.message}`);
        throw new OrientationError(`The summary was refused and nothing was saved:\n${reasons.join("\n")}`);
      }
      this.store.setSummary(row.id, parsed.data, this.ports.now());
      this.ports.changed();
      return "Summary saved. Call orient_finish when the orientation is complete.";
    });
  }

  finish(threadId: string): Promise<string> {
    return this.asBuilder(threadId, async (row) => {
      if (row.summary === null) throw new OrientationError("Set the summary with orient_summary before finishing.");
      if (row.depth === "walkthrough") this.walkthroughProblems(row.id);
      await this.verifyRows(row);
      this.live(row.id, threadId);
      this.store.promoteReady(row.id, this.ports.now());
      this.ports.changed();
      await this.putAway(threadId);
      return "The orientation is ready.";
    });
  }

  /** Refuses a walkthrough with no chapter, or with listings no note names as `Listing N`. */
  private walkthroughProblems(id: string): void {
    const blocks = this.store.blocks(id);
    if (!blocks.some((block) => block.kind === "chapter")) throw new OrientationError("A walkthrough needs at least one chapter; add one with orient_chapter.");
    const named = new Set<number>();
    for (const block of blocks) {
      if (block.kind !== "note") continue;
      for (const match of block.markdown.matchAll(LISTING_REF)) named.add(Number(match[1]));
    }
    const unnamed = blocks.filter((block): block is ListingRow => block.kind === "listing" && !named.has(block.number)).map((block) => `Listing ${block.number}`);
    if (unnamed.length > 0) {
      throw new OrientationError(`Every listing must be referenced as "Listing N" in a note. Not referenced: ${unnamed.join(", ")}. Mention them in a note, or remove them.`);
    }
  }

  // ── the user's actions ────────────────────────────────────────────────────

  cancel(orientationId: string): Promise<void> {
    return this.exclusive(`orientation:${orientationId}`, async () => {
      const row = this.store.get(orientationId);
      if (row === null || !this.store.transition(orientationId, ["starting", "building"], "cancelled", this.ports.now(), "Cancelled.")) {
        throw new OrientationError("That orientation is not being built.");
      }
      this.ports.changed();
      await this.putAway(row.builderThreadId);
    });
  }

  delete(orientationId: string): void {
    const row = this.store.get(orientationId);
    if (row === null) throw new OrientationError("That orientation is gone.");
    if (isLive(row.status)) throw new OrientationError("That orientation is still being built; cancel it first.");
    this.store.delete(orientationId);
    this.ports.changed();
  }

  /**
   * Re-checks every listing against its file. With `ifOlderThanMs`, does nothing when every listing was
   * checked more recently than that (the tab opening). Answers `checked: 0` and no drift, changing nothing,
   * when neither the orientation's environment nor the project's checkout on its host can be reached.
   */
  verify(orientationId: string, opts: { ifOlderThanMs?: number } = {}): Promise<{ checked: number; drift: string[] }> {
    return this.exclusive(`orientation:${orientationId}`, async () => {
      const row = this.store.get(orientationId);
      if (row === null) throw new OrientationError("That orientation is gone.");
      return this.verifyRows(row, opts.ifOlderThanMs);
    });
  }

  private async verifyRows(row: OrientationRow, ifOlderThanMs?: number): Promise<{ checked: number; drift: string[] }> {
    const listings = this.store.blocks(row.id).filter((block): block is ListingRow => block.kind === "listing");
    if (listings.length === 0) return { checked: 0, drift: [] };
    if (ifOlderThanMs !== undefined) {
      const since = this.ports.now() - ifOlderThanMs;
      if (listings.every((listing) => listing.check !== null && listing.check.checkedAt > since)) return { checked: 0, drift: [] };
    }
    const root = await this.rootOf(row);
    this.alive();
    if (root === null) return { checked: 0, drift: [] };
    const texts = new Map<string, string | null | undefined>();
    for (const path of new Set(listings.map((listing) => listing.path))) {
      const read = await this.ports.readFile(root, path);
      this.alive();
      // A failed read leaves the listing's state as it was; missing, binary or oversized reads as missing.
      texts.set(path, read === null ? undefined : read.kind === "text" ? read.text : null);
    }
    if (this.store.get(row.id) === null) return { checked: 0, drift: [] };
    let checked = 0;
    const now = this.ports.now();
    for (const listing of listings) {
      const text = texts.get(listing.path);
      if (text === undefined) continue;
      this.store.setCheck(row.id, listing.ordinal, checkListing(text, listing), now);
      checked += 1;
    }
    this.ports.changed();
    const drift = this.store
      .blocks(row.id)
      .filter((block): block is ListingRow => block.kind === "listing")
      .map(driftLine)
      .filter((line): line is string => line !== null);
    return { checked, drift };
  }

  /** Where an orientation's files are read: its environment, else the project's checkout on its host. */
  private async rootOf(row: OrientationRow): Promise<FileRoot | null> {
    if (row.environmentId !== null) {
      const root = await this.ports.environmentRoot(row.environmentId);
      if (root !== null) return root;
    }
    if (row.hostId === null) return null;
    const rootPath = await this.ports.projectCheckout(row.projectId, row.hostId);
    return rootPath === null ? null : { hostId: row.hostId, rootPath };
  }

  /**
   * Writes the orientation as Markdown at a workspace path. An existing file is replaced only with
   * `replace`, and only if it is still the file that was read (`FileConflict` otherwise).
   */
  async export(orientationId: string, input: { path: string; replace: boolean }): Promise<{ exists: true } | { written: string }> {
    const path = workspacePath(input.path.trim());
    if (path === null) throw new OrientationError(OUTSIDE);
    const row = this.store.get(orientationId);
    if (row === null || row.status !== "ready" || row.summary === null) throw new OrientationError("Only a ready orientation can be exported.");
    const markdown = renderOrientationMarkdown({ title: row.title, readyAt: row.readyAt ?? row.updatedAt, headSha: row.headSha, summary: row.summary, blocks: this.store.blocks(row.id) });
    const root = await this.rootOf(row);
    this.alive();
    if (root === null) throw new OrientationError("The project's checkout cannot be reached, so nothing was written.");
    const current = await this.ports.readFile(root, path);
    this.alive();
    if (current === null) throw new OrientationError(`Could not read ${path}, so nothing was written; try again.`);
    if (current.kind === "binary" || current.kind === "too-large") throw new OrientationError(`${path} exists and is not a text file this can replace; choose another path.`);
    if (current.kind === "text" && !input.replace) return { exists: true };
    try {
      await this.ports.writeFile(root, path, markdown, current.kind === "text" ? current.sha256 : null);
    } catch (error) {
      this.alive();
      if (error instanceof FileConflict) throw new OrientationError(`${path} changed while you were deciding; export again.`);
      throw new OrientationError(`Could not write ${path}: ${errorText(error)}`);
    }
    this.alive();
    return { written: path };
  }

  // ── reads for the API ─────────────────────────────────────────────────────

  view(key: string): { current: OrientationRow | null; live: OrientationRow | null } {
    return { current: this.store.ready(key), live: this.store.live(key) };
  }

  document(orientationId: string): { row: OrientationRow; blocks: BlockRow[] } | null {
    const row = this.store.get(orientationId);
    return row === null ? null : { row, blocks: this.store.blocks(row.id) };
  }

  // ── putting a builder away ────────────────────────────────────────────────

  /** Stops the thread, then archives it whatever the stop did; failures are logged, never thrown. */
  private async putAway(threadId: string | null): Promise<void> {
    if (threadId === null) return;
    try {
      await this.ports.stopThread(threadId);
    } catch (error) {
      this.warn(`Could not stop orientation builder ${threadId}: ${errorText(error)}`);
    } finally {
      try {
        await this.ports.archiveThread(threadId);
      } catch (error) {
        this.warn(`Could not archive orientation builder ${threadId}: ${errorText(error)}`);
      }
    }
  }

  /** Nothing in this copy touches the store afterwards. */
  dispose(): void {
    this.disposed = true;
  }
}
