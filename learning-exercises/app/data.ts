/**
 * The app's reads and writes. Reads go through `experimental_useRpcQuery`, which bb refreshes when the
 * server invalidates `LEARNING_TAG` (any change to an offer or a session); writes go through `useRpc`.
 */
import { experimental_useRpcQuery, experimental_useSidebarThreads, useRpc } from "@get-bb/plugin-sdk/app";

import { rpcContract, type RpcContract } from "../shared/contract";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLearningRpc() {
  return useRpc<RpcContract>();
}

export function useThreadView(threadId: string | null, enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "threadView", input: { threadId: threadId ?? "" }, enabled: enabled && threadId !== null });
}

export function useProjectSessions(threadId: string, limit: number, enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "projectSessions", input: { threadId, limit }, enabled });
}

export function useOrientation(threadId: string, enabled: boolean) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "orientation", input: { threadId }, enabled });
}

export function useSessionDetail(sessionId: string | null) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "sessionDetail", input: { sessionId: sessionId ?? "" }, enabled: sessionId !== null });
}

export function useTopicChoices(threadId: string, enabled: boolean) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "topicChoices", input: { threadId }, enabled });
}

/** The thread's sidebar row, for its status and origin; undefined while the list loads or for an unknown id. */
export function useSidebarThread(threadId: string | null) {
  const { threads } = experimental_useSidebarThreads();
  return threadId === null ? undefined : threads.find((thread) => thread.id === threadId);
}

export function useOrientationDocument(orientationId: string) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "orientationDocument", input: { orientationId } });
}
