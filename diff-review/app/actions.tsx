/**
 * What a thread card can do, handed down through context so the cards Pierre renders inside the diff
 * (annotations) reach the same RPCs as the rest of the tab. A failed call shows bb's toast and
 * rejects, so the composer that started it keeps its text.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import type { ReviewThread, Severity, Side, ThreadStatus } from "../shared/types";
import { errorMessage } from "./use-review";

export interface NewThread {
  filePath: string;
  side: Side | null;
  startLine: number;
  endLine: number;
  anchorContent: string | null;
  body: string;
  severity: Severity | null;
}

export interface ReviewActions {
  create(thread: NewThread): Promise<void>;
  reply(reviewThreadId: string, body: string): Promise<void>;
  edit(commentId: string, body: string): Promise<void>;
  remove(commentId: string): Promise<void>;
  setStatus(reviewThreadId: string, status: ThreadStatus): Promise<void>;
  openThread(threadId: string): void;
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
  putThread,
  refreshThreads,
  children,
}: {
  sessionId: string;
  putThread(thread: ReviewThread): void;
  refreshThreads(): Promise<void>;
  children: ReactNode;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const actions = useMemo<ReviewActions>(
    () => ({
      create: (thread) =>
        reported("Could not add the comment", async () => {
          putThread((await rpc.call("createThread", { sessionId, ...thread })).thread);
        }),
      reply: (reviewThreadId, body) =>
        reported("Could not reply", async () => {
          putThread((await rpc.call("addComment", { reviewThreadId, body })).thread);
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
    }),
    [rpc, navigate, sessionId, putThread, refreshThreads],
  );
  return <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>;
}
