import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../server";
import type { SkillDocument, SkillList } from "../shared/skills";
import { chatText, withCommand, writesToThread } from "./insert";

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
 * **Add to chat**: puts `/name ` at the start of the thread's composer draft
 * without sending it, then hands the screen back and focuses the composer. `useComposer()` writes to the thread a slot is mounted for — its
 * composer for the popover, its draft for the side panel — so the button is
 * offered only when that is this thread.
 */
export function useAddToChat(threadId: string, onAdded: () => void) {
  const composer = useComposer();
  return {
    canAdd: writesToThread(composer.scope, threadId),
    add(name: string) {
      composer.updateText((draft) => withCommand(draft, chatText(name)));
      onAdded();
      composer.focus();
    },
  };
}
