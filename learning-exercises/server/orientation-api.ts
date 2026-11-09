/**
 * The orientation RPC handlers behind `shared/contract.ts`: the Learning tab's Orientation section and
 * the walkthrough tab read and change orientations through these. The service decides (`orientation.ts`);
 * this turns its rows into the shapes the app reads (`OrientationSchema`, `OrientationBlockSchema`), with
 * the block counts and a workspace to link files against, and checks that an id belongs to the thread's
 * project before a session starts on it.
 *
 * `verify` answers `checked: 0` both when it had nothing it could read and when it skipped a recent check,
 * so nothing here reads `checked: 0` as "every listing is current": the listing states are in the blocks.
 */
import type { RpcContract } from "../shared/contract";
import type { Orientation, OrientationBlock } from "../shared/orientation";
import type { Workspace } from "../shared/types";
import { projectOf, requireThread } from "./api";
import { OrientationError, type OrientationService } from "./orientation";
import type { BlockRow, OrientationRow, OrientationStore } from "./orientation-store";
import { canStartByHand } from "./policy";
import type { Ports } from "./ports";
import type { SessionService } from "./sessions";
import { workspaceOf } from "./workspace";

type Input<M extends keyof RpcContract> = import("zod").infer<RpcContract[M]["input"]>;
type Output<M extends keyof RpcContract> = import("zod").infer<RpcContract[M]["output"]>;

/** How old a walkthrough's last check may be before opening it checks again. */
const DOCUMENT_VERIFY_MS = 5 * 60_000;

export interface OrientationApiDeps {
  ports: Ports;
  sessions: SessionService;
  orientations: OrientationService;
  /** Read only, for the block counts the app's view of an orientation carries. */
  orientationStore: OrientationStore;
}

/** An orientation as the app reads it: the row's public fields, its block counts and a workspace for links. */
export function publicOrientation(row: OrientationRow, counts: { blocks: number; listings: number }, workspace: Workspace | null): Orientation {
  return {
    id: row.id,
    status: row.status,
    depth: row.depth,
    title: row.title,
    summary: row.summary,
    blocks: counts.blocks,
    listings: counts.listings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    readyAt: row.readyAt,
    error: row.error,
    headSha: row.headSha,
    workspace,
  };
}

/** A stored block without what only the server uses (the listing's hash, the orientation id). */
export function publicBlock(block: BlockRow): OrientationBlock {
  if (block.kind === "chapter") return { kind: "chapter", ordinal: block.ordinal, title: block.title };
  if (block.kind === "note") return { kind: "note", ordinal: block.ordinal, markdown: block.markdown };
  const { kind, ordinal, number, caption, path, startLine, endLine, text, ref, check } = block;
  return { kind, ordinal, number, caption, path, startLine, endLine, text, ref, check };
}

export class OrientationApi {
  constructor(private readonly deps: OrientationApiDeps) {}

  private present(row: OrientationRow | null, workspace: Workspace | null): Orientation | null {
    return row === null ? null : publicOrientation(row, this.deps.orientationStore.counts(row.id), workspace);
  }

  /**
   * The project's ready and live orientations, and the last failed or cancelled build when the section
   * should show its reason: no build is live, and it was started after the ready one (a rebuild that did
   * not make it). All linked against this thread's workspace (the reader's checkout). `canStart` mirrors
   * what `start` would refuse: a thread that may start by hand, with an environment, no build under way
   * for the project, and the load-time clean-up done.
   */
  async orientation({ threadId }: Input<"orientation">): Promise<Output<"orientation">> {
    const { ports, orientations, orientationStore } = this.deps;
    const thread = await requireThread(ports, threadId);
    const { key } = await projectOf(ports, thread);
    const { current, live } = orientations.view(key);
    const ended = live === null ? orientationStore.latestEnded(key) : null;
    // Started once the ready one was ready (one build at a time, so a rebuild cannot start earlier); not
    // compared by `updatedAt`, which a verify moves on the ready row.
    const last = ended !== null && (current === null || ended.createdAt >= (current.readyAt ?? current.createdAt)) ? ended : null;
    const workspace = await workspaceOf(ports, thread);
    const cleaning = !orientations.clean;
    return {
      current: this.present(current, workspace),
      live: this.present(live, workspace),
      last: this.present(last, workspace),
      canStart: canStartByHand(thread) && thread.environmentId !== null && live === null && !cleaning,
      cleaning,
    };
  }

  /**
   * The walkthrough. A ready orientation's listings are checked again first when its last verify that
   * reached the checkout is over five minutes old (`verifiedAt`; a file whose read fails does not reopen
   * the window); the states come back in each listing's `check`. Links resolve against the source
   * thread's workspace (the input names no thread).
   */
  async orientationDocument({ orientationId }: Input<"orientationDocument">): Promise<Output<"orientationDocument">> {
    const { ports, orientations, orientationStore } = this.deps;
    const found = orientationStore.get(orientationId);
    if (found === null) throw new OrientationError("That orientation is gone.");
    // Only a ready one: a check writes to the row, and an ended row is never written to (its purge waits).
    if (found.status === "ready") await orientations.verify(orientationId, { ifOlderThanMs: DOCUMENT_VERIFY_MS });
    const document = orientations.document(orientationId);
    if (document === null) throw new OrientationError("That orientation is gone.");
    const workspace = await workspaceOf(ports, document.row.sourceThreadId);
    return { orientation: publicOrientation(document.row, orientationStore.counts(document.row.id), workspace), blocks: document.blocks.map(publicBlock) };
  }

  startOrientation({ threadId, depth }: Input<"startOrientation">): Promise<Output<"startOrientation">> {
    return this.deps.orientations.start({ sourceThreadId: threadId, depth });
  }

  async cancelOrientation({ orientationId }: Input<"cancelOrientation">): Promise<null> {
    await this.deps.orientations.cancel(orientationId);
    return null;
  }

  deleteOrientation({ orientationId }: Input<"deleteOrientation">): null {
    this.deps.orientations.delete(orientationId);
    return null;
  }

  /** Only a ready orientation: a check writes to the row, and a failed one's purge must not wait for it. */
  verifyOrientation({ orientationId }: Input<"verifyOrientation">): Promise<Output<"verifyOrientation">> {
    const row = this.deps.orientationStore.get(orientationId);
    if (row === null) throw new OrientationError("That orientation is gone.");
    if (row.status !== "ready") throw new OrientationError("Only a ready orientation can be verified.");
    return this.deps.orientations.verify(orientationId);
  }

  exportOrientation({ orientationId, path, replace, expectedSha256 }: Input<"exportOrientation">): Promise<Output<"exportOrientation">> {
    return this.deps.orientations.export(orientationId, { path, replace, expectedSha256 });
  }

  browseOrientationFolder({ orientationId, dir }: Input<"browseOrientationFolder">): Promise<Output<"browseOrientationFolder">> {
    return this.deps.orientations.browse(orientationId, dir);
  }

  /**
   * Checks the project's ready orientation again (no skip window: the session's brief carries the drift),
   * then starts the session on it in a new visible thread. An id that is not the ready orientation of
   * this thread's project is refused.
   */
  async startOrientationSession({ threadId, orientationId }: Input<"startOrientationSession">): Promise<Output<"startOrientationSession">> {
    const { ports, orientations, sessions } = this.deps;
    const thread = await requireThread(ports, threadId);
    const { key, name } = await projectOf(ports, thread);
    const current = orientations.view(key).current;
    if (current === null || current.id !== orientationId || current.summary === null) {
      throw new OrientationError("That orientation is not this project's ready orientation any more.");
    }
    const { drift } = await orientations.verify(orientationId);
    const started = await sessions.startOrientationSession({ sourceThreadId: thread.id, orientationId, summary: current.summary, drift, projectName: name });
    return { threadId: started.threadId };
  }
}
