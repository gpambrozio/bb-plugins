import { useComposer, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../server";
import type { SkillDocument, SkillList } from "../shared/skills";
import { insertionText, invocationText, sendInvocation, withCommand, writesToThread } from "./invoke";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One RPC answer for `key`, asked again by `reload`. A refetch keeps the last
 * answer on screen until the new one lands; a new key starts from loading, so
 * one thread's skills never show under another's.
 */
function useLoaded<T>(key: string, load: () => Promise<T>): { state: Loaded<T>; reload: () => void } {
  const [answer, setAnswer] = useState<{ key: string; state: Loaded<T> }>({ key, state: { status: "loading" } });
  const [generation, setGeneration] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    loadRef.current().then(
      (data) => live && setAnswer({ key, state: { status: "ready", data } }),
      (error: unknown) => live && setAnswer({ key, state: { status: "error", message: messageOf(error) } }),
    );
    return () => {
      live = false;
    };
  }, [key, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { state: answer.key === key ? answer.state : { status: "loading" }, reload };
}

/** Everything one thread's agent can run. The composer button and the panel each hold one. */
export function useSkillList(threadId: string) {
  const rpc = useRpc<RpcContract>();
  return useLoaded<SkillList>(threadId, () => rpc.call("list", { threadId }));
}

export function useSkillDocument(threadId: string, skillId: string) {
  const rpc = useRpc<RpcContract>();
  return useLoaded<SkillDocument>(`${threadId}\n${skillId}`, () => rpc.call("read", { threadId, skillId }));
}

/**
 * Owns the arguments field and the send. The re-entrancy guard lives here, in
 * a ref rather than state, so a double click cannot invoke the skill twice on
 * the user's thread before the button re-renders as disabled.
 *
 * The message is queued behind a running turn rather than steered into it: a
 * skill invocation is a turn of its own, not a correction to the one running.
 */
export function useInvoke(threadId: string, onInvoked: () => void) {
  const sdk = useSdk();
  const [args, setArgs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const inFlight = useRef(false);

  // Whether this detail is still the one on show; a send outlives it when the
  // user goes back or the popover closes. See `sendInvocation`.
  const showing = useRef(false);
  useEffect(() => {
    showing.current = true;
    return () => {
      showing.current = false;
    };
  }, []);

  async function invoke(name: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsSending(true);
    setError(null);
    await sendInvocation({
      send: (text) =>
        sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] }),
      text: invocationText(name, args),
      isShowing: () => showing.current,
      onSent: onInvoked,
      onFailure(message) {
        setError(message);
        setIsSending(false);
      },
      onUnseenFailure(message) {
        toast.error(`Could not invoke /${name}: ${message}`);
      },
    });
    inFlight.current = false;
  }

  return { args, setArgs, invoke, error, isSending };
}

/**
 * **Insert in chat**: puts `/name args ` at the start of the thread's composer
 * draft without sending it, then hands the screen back and focuses the
 * composer. `useComposer()` writes to the thread a slot is mounted for — its
 * composer for the popover, its draft for the side panel — so the button is
 * offered only when that is this thread.
 */
export function useInsertInChat(threadId: string, onInserted: () => void) {
  const composer = useComposer();
  return {
    canInsert: writesToThread(composer.scope, threadId),
    insert(name: string, args: string) {
      composer.updateText((draft) => withCommand(draft, insertionText(name, args)));
      onInserted();
      composer.focus();
    },
  };
}
