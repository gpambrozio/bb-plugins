/**
 * What a thread card can do, handed down through context so the cards Pierre renders inside the diff
 * (annotations) reach the same RPCs as the rest of the tab. A failed call shows bb's toast and
 * rejects, so the composer that started it keeps its text.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import type { DiffFile, ReviewThread, Severity, Side, Target, ThreadStatus } from "../shared/types";
import { fileRef } from "./open-file";
import { errorMessage } from "./use-review";

export interface NewThread {
  filePath: string;
  side: Side | null;
  startLine: number;
  endLine: number;
  anchorContent: string | null;
  body: string;
  severity: Severity | null;
  /** The file's revision in the view, for a file or line thread. */
  fileRevision?: string | null;
}

export interface ReviewActions {
  create(thread: NewThread): Promise<void>;
  reply(reviewThreadId: string, body: string): Promise<void>;
  edit(commentId: string, body: string): Promise<void>;
  remove(commentId: string): Promise<void>;
  setStatus(reviewThreadId: string, status: ThreadStatus): Promise<void>;
  openThread(threadId: string): void;
  /** Marks a file Viewed (folding it) or clears its mark. */
  setViewed(file: DiffFile, viewed: boolean): Promise<void>;
  /** Opens the file in bb's preview, at the version the view shows; false when bb cannot. */
  openFile(file: DiffFile, line?: number): boolean;
  /** Whether `openFile` can open this file in this view. */
  canOpenFile(file: DiffFile): boolean;
}

const ActionsContext = createContext<ReviewActions | null>(null);

export function useActions(): ReviewActions {
  const actions = useContext(ActionsContext);
  if (actions === null) throw new Error("useActions outside ReviewActionsProvider");
  return actions;
}

async function reported<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    toast.error(`${what}: ${errorMessage(error)}`);
    throw error;
  }
}

export function ReviewActionsProvider({
  sessionId,
  threadId,
  view,
  putThread,
  putViewed,
  refreshThreads,
  children,
}: {
  sessionId: string;
  /** The thread whose Review tab this is. */
  threadId: string;
  /** The view on screen: its target, workspace and merge base, for Viewed marks and Open. */
  view: { target: Target; environmentId: string; mergeBaseRef: string | null };
  putThread(thread: ReviewThread): void;
  putViewed(sessionId: string, path: string, viewed: DiffFile["viewed"]): void;
  refreshThreads(): Promise<void>;
  children: ReactNode;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const actions = useMemo<ReviewActions>(
    () => ({
      create: (thread) =>
        reported("Could not add the comment", async () => {
          putThread((await rpc.call("createThread", { sessionId, threadId, ...thread })).thread);
        }),
      reply: (reviewThreadId, body) =>
        reported("Could not reply", async () => {
          putThread((await rpc.call("addComment", { reviewThreadId, body, threadId })).thread);
        }),
      edit: (commentId, body) =>
        reported("Could not save the comment", async () => {
          putThread((await rpc.call("editComment", { commentId, body })).thread);
        }),
      remove: (commentId) =>
        reported("Could not delete the comment", async () => {
          await rpc.call("deleteComment", { commentId });
          await refreshThreads();
        }),
      setStatus: (reviewThreadId, status) =>
        reported("Could not change the thread", async () => {
          putThread((await rpc.call("setStatus", { reviewThreadId, status })).thread);
        }),
      openThread: (threadId) => navigate.toThread(threadId),
      setViewed: (file, viewed) =>
        reported(viewed ? "Could not mark the file viewed" : "Could not clear the Viewed mark", async () => {
          const before = file.viewed;
          putViewed(sessionId, file.path, viewed ? "yes" : "no");
          try {
            await rpc.call("setViewed", { threadId, target: view.target, path: file.path, revision: file.revision, viewed });
          } catch (error) {
            putViewed(sessionId, file.path, before);
            throw error;
          }
        }),
      canOpenFile: (file) => fileRef(view.target, file, view.mergeBaseRef) !== null,
      openFile: (file, line) => {
        const at = fileRef(view.target, file, view.mergeBaseRef);
        if (at === null) return false;
        return navigate.experimental_openFilePreview({
          target: { kind: "workspace", environmentId: view.environmentId, path: file.path, ...(at.ref === null ? {} : { experimental_ref: at.ref }) },
          location: line === undefined ? null : { kind: "line", line, column: null },
        });
      },
    }),
    [rpc, navigate, sessionId, threadId, view.target, view.environmentId, view.mergeBaseRef, putThread, putViewed, refreshThreads],
  );
  return <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>;
}
