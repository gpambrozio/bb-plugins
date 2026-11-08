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
 * old failed rows, so a terminal row is never touched). Cancel puts the builder away (stopped, then
 * archived), logging errors rather than throwing them into the user's action. Finish does not: it runs
 * inside the builder's own tool call, so the builder is put away once it goes idle (`onIdle`), or by a
 * reconcile. A put-away bb does not confirm (`putAway`) is recorded in the store, outside the row, so a
 * reload sees it too; while any is recorded `clean` is false and starts are refused, and every sweep
 * tries it again (`retryPutAways`) until bb confirms the thread archived or gone. After `dispose()` no
 * continuation of this copy touches the store (`alive()`).
 *
 * The builder's lifecycle (§7). Its first idle gets one reminder (a visible line and an agent-only part,
 * invariant 6), its second fails the row, and a failed turn fails it at once (`onIdle`, `onFailed`). The
 * sweep cancels builds older than 30 minutes and purges failed and cancelled rows after 7 days. Every path
 * that ends a row takes the orientation's lock, as the builder's writes do, so nothing writes to a row
 * once it has ended (a write would bump its `updated_at` and put off its purge).
 *
 * Reload safety fails closed: `clean` starts false, and only a reconcile that read and settled everything
 * (pending put-aways first) sets it, so no start is allowed before the load-time check. `reconcile` keeps a live row whose builder
 * is working, binds a `starting` row to the thread bb made for it (found by its metadata) when that thread
 * works, fails the rest ("Interrupted by a reload.") and puts their threads away, then archives every
 * thread of this plugin whose orientation id no live row has it building (finished builders among them).
 * A `starting` row with no thread yet is failed but leaves `clean` false: a spawn the old copy sent may
 * still answer, and the next sweep's reconcile archives that thread if bb has made it by then. A thread bb
 * makes later still is listed by no reconcile until the next load, so it is put away on its first tool call
 * (`builderFor`) or its first idle or failed turn (`onIdle`, `onFailed`): this plugin started it and its
 * metadata names an orientation that is not live. Reconcile runs only at load and from sweeps while
 * `clean` is false, when starts are refused, so it never meets a spawn of its own copy.
 */
import { LIVE_ORIENTATION_STATUSES, ORIENT_LIMITS, OrientationSummarySchema, parseLineRange, type OrientationDepth, type OrientationStatus } from "../shared/orientation";
import { PLUGIN_ID } from "../shared/types";
import { workspacePath } from "../shared/workspace-path";
import { buildBuilderBrief, builderStartLine } from "./content";
import { isShowboatImageLine, renderOrientationMarkdown } from "./orientation-markdown";
import type { BlockRow, OrientationRow, OrientationStore } from "./orientation-store";
import { checkListing, sha256, sliceLines, type ListingCheck } from "./orientation-verify";
import { canStartByHand, projectKey } from "./policy";
import { FileConflict, type FileRead, type FileRoot, type PluginThread, type Ports } from "./ports";
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
/** The thread statuses of a builder at work: bb runs, queues or starts its turn. */
const WORKING = new Set(["active", "pending", "starting"]);
const INTERRUPTED = "Interrupted by a reload.";
const REMINDER = "Reminder: finish the orientation.";
const REMINDER_AGENT =
  "You stopped without finishing the orientation. Call orient_finish now, or fix what it refused and call it again. Do not edit files. If you stop again without finishing, the build fails.";
/** A build still live after this long is cancelled by the sweep. */
const BUILD_CAP_MS = 30 * 60_000;
/** Failed and cancelled rows are purged this long after they last changed. */
const PURGE_AFTER_MS = 7 * 24 * 60 * 60_000;
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

/** Whether a new check says what the stored one said: the same state at the same range. */
function sameCheck(before: ListingRow["check"], after: ListingCheck): boolean {
  return before !== null && before.state === after.state && before.startLine === after.startLine && before.endLine === after.endLine;
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
  /** False until a reconcile has settled what an earlier copy left; starts are refused meanwhile. */
  private isClean = false;
  /** The reconcile under way, so a sweep does not start a second one beside it. */
  private reconciling: Promise<void> | null = null;
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
      // Ended while bb spawned it. A builder that bound itself is put away by whoever ended the row (or,
      // after a finish, once it goes idle); one that never called is put away here.
      if (current?.builderThreadId !== threadId) await this.putAway(threadId, row.id);
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
    if (row === null || !isLive(row.status)) {
      // A thread bb made for a build that has ended, as when a reload landed while it was being spawned.
      // Put away in the background: this is the thread's own tool call, and a stop may wait for its answer.
      if (info.archivedAt === null) this.observe(this.putAwayStray(threadId, orientationId), threadId);
      throw new OrientationError(NOT_BUILDING);
    }
    if (row.builderThreadId !== null) throw new OrientationError(NOT_BUILDING);
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
      // showboat's own rule: a line starting with an image reference is an image block, text after it and all.
      if (text.split("\n").some(isShowboatImageLine)) {
        throw new OrientationError("A note may not start a line with an image (`![…](…)`): orientations keep no images, and an export would read that whole line as one.");
      }
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
      // The builder is not stopped here: this runs inside its own tool call, and a stop that waits for
      // the turn would wait for this answer. It is put away when it goes idle, or by the sweep.
      return "The orientation is ready.";
    });
  }

  /**
   * Refuses a walkthrough with no chapter, with listings no note names as `Listing N`, or with a note that
   * names a listing that does not exist (a pop leaves a gap in the numbers, so counting goes wrong).
   */
  private walkthroughProblems(id: string): void {
    const blocks = this.store.blocks(id);
    if (!blocks.some((block) => block.kind === "chapter")) throw new OrientationError("A walkthrough needs at least one chapter; add one with orient_chapter.");
    const named = new Set<number>();
    for (const block of blocks) {
      if (block.kind !== "note") continue;
      for (const match of block.markdown.matchAll(LISTING_REF)) named.add(Number(match[1]));
    }
    const listings = blocks.filter((block): block is ListingRow => block.kind === "listing");
    const unnamed = listings.filter((block) => !named.has(block.number)).map((block) => `Listing ${block.number}`);
    if (unnamed.length > 0) {
      throw new OrientationError(`Every listing must be referenced as "Listing N" in a note. Not referenced: ${unnamed.join(", ")}. Mention them in a note, or remove them.`);
    }
    const numbers = new Set(listings.map((block) => block.number));
    const dangling = [...named].filter((number) => !numbers.has(number)).sort((a, b) => a - b);
    if (dangling.length > 0) {
      const there = listings.length === 0 ? "This walkthrough has no listings." : `This walkthrough's listings are numbered ${listings.map((block) => block.number).join(", ")}.`;
      throw new OrientationError(
        `A note mentions a listing that does not exist: ${dangling.map((number) => `no Listing ${number}`).join(", ")}. ${there} Use the number each orient_listing call returned (a pop leaves a gap); remove the note with orient_pop and add it again with the right numbers.`,
      );
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
      // A put-away that fails is recorded and retried by the sweep; starts stay refused until then.
      await this.putAway(row.builderThreadId, orientationId);
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
   * Re-checks every listing against its file. With `ifOlderThanMs`, does nothing when the last verify that
   * reached the checkout is more recent than that (the tab opening): the window is the orientation's own
   * `verifiedAt`, not each listing's check, so a file whose read keeps failing cannot make every opening
   * check again. Answers `checked: 0` and no drift, changing nothing, when neither the orientation's
   * environment nor the project's checkout on its host can be reached. Tells the app to refetch
   * (`changed`) only when a listing's state or range changed, since the app's refetch of the walkthrough
   * is what calls this again.
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
    if (ifOlderThanMs !== undefined && row.verifiedAt !== null && row.verifiedAt > this.ports.now() - ifOlderThanMs) return { checked: 0, drift: [] };
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
    let anyChanged = false;
    const now = this.ports.now();
    for (const listing of listings) {
      const text = texts.get(listing.path);
      if (text === undefined) continue;
      const check = checkListing(text, listing);
      this.store.setCheck(row.id, listing.ordinal, check, now);
      checked += 1;
      if (!sameCheck(listing.check, check)) anyChanged = true;
    }
    this.store.setVerified(row.id, now);
    if (anyChanged) this.ports.changed();
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
   * Writes the orientation as Markdown at a workspace path. Without `replace`, an existing file is left
   * alone and its hash answered (`{ exists, sha256 }`), so the app can ask; the replace call passes that
   * hash back as `expectedSha256`, and the write is refused (`FileConflict`) if the file changed while the
   * user decided. Null or absent `expectedSha256` means the file must not exist.
   */
  async export(
    orientationId: string,
    input: { path: string; replace: boolean; expectedSha256?: string | null },
  ): Promise<{ exists: true; sha256: string } | { written: string }> {
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
    if (current.kind === "text" && !input.replace) return { exists: true, sha256: current.sha256 };
    // On a replace, the caller's hash, not this read's: the file must still be the one the user saw.
    const expected = input.replace ? (input.expectedSha256 ?? null) : null;
    try {
      await this.ports.writeFile(root, path, markdown, expected);
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

  /**
   * Stops the thread, then archives it whatever the stop did; failures are logged, never thrown. True when
   * the thread is put away (or there is none): both calls worked, or bb confirms it archived or gone
   * (`confirmedPutAway`: a stop that failed before an archive that worked, an archive refused because it
   * already was). Otherwise the thread is recorded as pending in the store, which keeps starts refused
   * (`clean`) until a sweep puts it away (`retryPutAways`); success forgets that record. Once this copy is
   * disposed nothing is recorded: the next copy's reconcile lists the thread instead.
   */
  private async putAway(threadId: string | null, orientationId: string): Promise<boolean> {
    if (threadId === null) return true;
    let stopped = true;
    try {
      await this.ports.stopThread(threadId);
    } catch (error) {
      stopped = false;
      this.warn(`Could not stop orientation builder ${threadId}: ${errorText(error)}`);
    }
    let archived = true;
    try {
      await this.ports.archiveThread(threadId);
    } catch (error) {
      archived = false;
      this.warn(`Could not archive orientation builder ${threadId}: ${errorText(error)}`);
    }
    if (this.disposed) return stopped && archived;
    const done = (stopped && archived) || (await this.confirmedPutAway(threadId));
    if (this.disposed) return done;
    if (done) {
      if (this.store.clearPutAway(threadId)) this.ports.changed();
    } else {
      if (this.store.markPutAwayPending(threadId, orientationId, this.ports.now())) this.ports.changed();
      this.warn(`Orientation builder ${threadId} is not put away yet; orientations stay refused until a sweep puts it away.`);
    }
    return done;
  }

  /**
   * Whether bb confirms the thread put away: archived, or gone (no thread by its id, and none of this
   * plugin's unarchived threads). A read that fails confirms nothing.
   */
  private async confirmedPutAway(threadId: string): Promise<boolean> {
    const info = await this.ports.thread(threadId);
    if (info !== null) return info.archivedAt !== null;
    if (this.disposed) return false;
    const listed = await this.ports.pluginThreadsWith(ORIENTATION_METADATA_KEY);
    return listed !== null && !listed.some((entry) => entry.threadId === threadId && !entry.archived);
  }

  /**
   * Puts away again, each under its orientation's lock, every builder whose put-away was not confirmed. A
   * record whose thread a live row builds with is stale and forgotten (a put-away is recorded only for an
   * ended build's thread or a stray, so this should not happen).
   */
  private async retryPutAways(): Promise<void> {
    for (const { threadId, orientationId } of this.store.pendingPutAways()) {
      if (this.disposed) return;
      await this.exclusive(`orientation:${orientationId}`, async () => {
        if (this.disposed || !this.store.isPutAwayPending(threadId)) return;
        const row = this.store.get(orientationId);
        const stale = row !== null && isLive(row.status) && row.builderThreadId === threadId;
        if (stale || (await this.confirmedPutAway(threadId))) {
          if (!this.disposed && this.store.clearPutAway(threadId)) this.ports.changed();
          return;
        }
        if (this.disposed) return;
        await this.putAway(threadId, orientationId);
      });
    }
  }

  // ── the builder's lifecycle ───────────────────────────────────────────────

  /** Whether `threadId` builds (or built) an orientation in the store. */
  isBuilderThread(threadId: string): boolean {
    return this.store.byBuilder(threadId) !== null;
  }

  /** `thread.idle` of a thread: the first idle of a builder reminds it, the second fails the build. */
  onIdle(threadId: string): Promise<void> {
    return this.settleBuilder(threadId, async (row) => {
      if (this.store.markReminded(row.id, this.ports.now())) {
        try {
          await this.ports.send(threadId, REMINDER, REMINDER_AGENT);
        } catch (error) {
          // It stays building, and the cap ends it if nothing else does.
          this.warn(`Could not remind orientation builder ${threadId}: ${errorText(error)}`);
        }
        return;
      }
      await this.failBuild(row.id, threadId, "The builder stopped before finishing.");
    });
  }

  /** `thread.failed` of a thread: a builder's failed turn fails the build at once. */
  onFailed(threadId: string): Promise<void> {
    return this.settleBuilder(threadId, (row) => this.failBuild(row.id, threadId, "The builder's turn failed."));
  }

  /**
   * Runs `whileBuilding` under the orientation's lock when `threadId` is the builder of a `building` row.
   * A builder whose row has ended (finish leaves it running) is put away instead, unless it already is.
   * Never rejects: it runs from bb's events.
   */
  private async settleBuilder(threadId: string, whileBuilding: (row: OrientationRow) => Promise<void>): Promise<void> {
    if (this.disposed) return;
    try {
      const found = this.store.byBuilder(threadId);
      if (found === null) return await this.settleStray(threadId);
      await this.exclusive(`orientation:${found.id}`, async () => {
        if (this.disposed) return;
        const row = this.store.get(found.id);
        if (row === null || row.builderThreadId !== threadId) return;
        if (row.status === "building") return whileBuilding(row);
        if (isLive(row.status)) return;
        const info = await this.ports.thread(threadId);
        if (this.disposed || info === null || info.archivedAt !== null) return;
        await this.putAway(threadId, found.id);
      });
    } catch (error) {
      this.warn(`Handling orientation builder ${threadId} failed: ${errorText(error)}`);
    }
  }

  /**
   * A thread no row has bound: put away when this plugin started it and its metadata names an orientation
   * that is not live (ended, purged or unknown). One whose row is still `starting` is left for its spawn.
   */
  private async settleStray(threadId: string): Promise<void> {
    const orientationId = await this.ports.metadataValue(threadId, ORIENTATION_METADATA_KEY);
    if (this.disposed || orientationId === null) return;
    const info = await this.ports.thread(threadId);
    if (this.disposed || info === null || info.originPluginId !== PLUGIN_ID || info.archivedAt !== null) return;
    await this.putAwayStray(threadId, orientationId);
  }

  /** Puts `threadId` away under the orientation's lock, unless that orientation is live by then. */
  private putAwayStray(threadId: string, orientationId: string): Promise<void> {
    return this.exclusive(`orientation:${orientationId}`, async () => {
      if (this.disposed) return;
      const row = this.store.get(orientationId);
      if (row !== null && isLive(row.status)) return;
      await this.putAway(threadId, orientationId);
    });
  }

  /** Work nobody awaits: a failure is logged, never left as an unhandled rejection. */
  private observe(work: Promise<unknown>, threadId: string): void {
    void work.catch((error: unknown) => this.warn(`Putting away orientation thread ${threadId} failed: ${errorText(error)}`));
  }

  /** Fails a `building` row with `message` and puts its builder away. Runs under the orientation's lock. */
  private async failBuild(id: string, threadId: string, message: string): Promise<void> {
    if (!this.store.transition(id, ["building"], "failed", this.ports.now(), message)) return;
    this.ports.changed();
    await this.putAway(threadId, id);
  }

  /**
   * Run every 5 minutes: cancels builds older than 30 minutes and puts their builders away, purges failed
   * and cancelled rows older than 7 days, and reconciles again while the plugin is not clean. Never rejects.
   */
  async sweep(): Promise<void> {
    try {
      const now = this.ports.now();
      for (const { id, createdAt } of this.store.allLive()) {
        if (this.disposed) return;
        if (now - createdAt <= BUILD_CAP_MS) continue;
        await this.exclusive(`orientation:${id}`, async () => {
          if (this.disposed) return;
          const row = this.store.get(id);
          if (row === null || !this.store.transition(id, ["starting", "building"], "cancelled", this.ports.now(), "Took longer than 30 minutes.")) return;
          this.ports.changed();
          await this.putAway(row.builderThreadId, id);
        });
      }
      if (this.disposed) return;
      if (this.store.purge(now - PURGE_AFTER_MS) > 0) this.ports.changed();
      // A reconcile retries the pending put-aways first; a clean copy retries them on its own.
      if (!this.isClean) await this.reconcile();
      else await this.retryPutAways();
    } catch (error) {
      this.warn(`The orientation sweep failed: ${errorText(error)}`);
    }
  }

  // ── reload safety ─────────────────────────────────────────────────────────

  /**
   * Whether starts are allowed: a reconcile has settled every builder an earlier copy left, and no builder's
   * put-away is still pending (a stop or archive that failed, retried by the sweep).
   */
  get clean(): boolean {
    return this.isClean && !this.store.hasPendingPutAways();
  }

  /**
   * Settles what an earlier copy of the plugin left (see the module header). `clean` becomes true only
   * when every read and every archive succeeded; otherwise it is false and the reason is logged. Never
   * rejects, and writes nothing once this copy is disposed.
   */
  reconcile(): Promise<void> {
    if (this.reconciling !== null) return this.reconciling;
    const run = this.reconcileOnce().finally(() => {
      this.reconciling = null;
    });
    this.reconciling = run;
    return run;
  }

  private async reconcileOnce(): Promise<void> {
    try {
      if (this.disposed) return;
      // Before the list, so a thread put away here is not listed and archived twice.
      await this.retryPutAways();
      if (this.disposed) return;
      const listed = await this.ports.pluginThreadsWith(ORIENTATION_METADATA_KEY);
      if (this.disposed) return;
      if (listed === null) {
        this.isClean = false;
        this.warn("Could not list this plugin's threads to find orientation builders an earlier copy left; orientations stay refused until a sweep can.");
        return;
      }
      // bb's port lists unarchived threads only; the flag is checked as well, so none is archived twice.
      const threads = listed.filter((entry) => !entry.archived);
      const handled = new Set<string>();
      let complete = true;
      for (const { id } of this.store.allLive()) {
        const settled = await this.exclusive(`orientation:${id}`, () => this.reconcileRow(id, threads, handled));
        if (this.disposed) return;
        if (!settled) complete = false;
      }
      for (const entry of threads) {
        if (handled.has(entry.threadId)) continue;
        const settled = await this.exclusive(`orientation:${entry.value}`, () => this.reconcileThread(entry.threadId, entry.value));
        if (this.disposed) return;
        if (!settled) complete = false;
      }
      this.isClean = complete;
      if (!complete) this.warn("Some orientation builders an earlier copy left are not settled yet; orientations stay refused until a sweep settles them.");
    } catch (error) {
      if (this.disposed) return;
      this.isClean = false;
      this.warn(`Reconciling orientation builders failed: ${errorText(error)}`);
    }
  }

  /**
   * One live row, under its lock: kept (and bound, when bb made its thread but no copy bound it) while its
   * builder works, otherwise failed and its thread put away. False when it is not settled yet.
   */
  private async reconcileRow(id: string, threads: readonly PluginThread[], handled: Set<string>): Promise<boolean> {
    if (this.disposed) return true;
    const row = this.store.get(id);
    if (row === null || !isLive(row.status)) return true;
    const threadId = row.builderThreadId ?? threads.find((entry) => entry.value === id)?.threadId ?? null;
    if (threadId === null) {
      // Its copy is gone and bb has no thread for it yet; a spawn still on its way leaves one behind for
      // the next reconcile to archive, so this one does not count as clean.
      if (this.store.transition(id, ["starting", "building"], "failed", this.ports.now(), INTERRUPTED)) this.ports.changed();
      return false;
    }
    handled.add(threadId);
    const state = await this.builderState(threadId);
    if (this.disposed) return true;
    const current = this.store.get(id);
    if (current === null || !isLive(current.status)) return true;
    if (state === "working") {
      if (current.builderThreadId === null && this.store.bindBuilder(id, threadId, this.ports.now())) {
        this.store.transition(id, ["starting"], "building", this.ports.now());
        this.ports.changed();
      }
      return true;
    }
    if (this.store.transition(id, ["starting", "building"], "failed", this.ports.now(), INTERRUPTED)) this.ports.changed();
    // A thread that is gone or already archived has nothing to put away (bb would refuse the archive).
    return state === "gone" ? true : this.putAway(threadId, id);
  }

  /**
   * `working`: the builder's thread is there, not archived, and running a turn, or idle after one (between
   * turns, its idle handled by whichever copy heard it; the cap bounds it). `gone`: deleted or archived
   * (or unreadable). `stopped`: idle with no turn ever started, errored or stopping.
   */
  private async builderState(threadId: string): Promise<"working" | "stopped" | "gone"> {
    const info = await this.ports.thread(threadId);
    if (this.disposed || info === null || info.archivedAt !== null) return "gone";
    if (WORKING.has(info.status)) return "working";
    if (info.status !== "idle") return "stopped";
    return (await this.ports.currentTurn(threadId)) !== null ? "working" : "stopped";
  }

  /** One of this plugin's threads with an orientation id, under that id's lock: archived unless a live row has it building. */
  private async reconcileThread(threadId: string, orientationId: string): Promise<boolean> {
    if (this.disposed) return true;
    const row = this.store.get(orientationId);
    if (row !== null && isLive(row.status) && row.builderThreadId === threadId) return true;
    return this.putAway(threadId, orientationId);
  }

  /** Nothing in this copy touches the store afterwards. */
  dispose(): void {
    this.disposed = true;
  }
}
