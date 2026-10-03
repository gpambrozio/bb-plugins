import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../server";
import type { SkillDocument, SkillList } from "../shared/skills";
import { type SkillCommand, withSkillCommand, writesToThread } from "./insert";
import { createAnswerChannel, type AnswerChannel } from "./answer-channel";

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
 *
 * With a `channel`, every holder of the same key shares its answers: one that
 * mounts starts from the last answer another holder has, and each answer one
 * holder gets reaches the rest.
 */
function useLoaded<T>(
  key: string,
  load: () => Promise<T>,
  channel?: AnswerChannel<T>,
): { state: Loaded<T>; reload: () => void } {
  const initial = (): Loaded<T> => {
    const last = channel?.last(key);
    return last === undefined ? { status: "loading" } : { status: "ready", data: last };
  };
  const [answer, setAnswer] = useState<{ key: string; state: Loaded<T> }>(() => ({ key, state: initial() }));
  const [generation, setGeneration] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (channel === undefined) return;
    return channel.subscribe(key, (data) => setAnswer({ key, state: { status: "ready", data } }));
  }, [channel, key]);

  useEffect(() => {
    let live = true;
    const ticket = channel?.ticket() ?? 0;
    loadRef.current().then(
      (data) => {
        if (!live) return;
        // Through the channel, this holder hears its own answer as a
        // subscriber, unless a newer one is already out.
        if (channel === undefined) setAnswer({ key, state: { status: "ready", data } });
        else channel.publish(key, data, ticket);
      },
      (error: unknown) => live && setAnswer({ key, state: { status: "error", message: messageOf(error) } }),
    );
    return () => {
      live = false;
    };
  }, [channel, key, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { state: answer.key === key ? answer.state : initial(), reload };
}

const skillLists = createAnswerChannel<SkillList>();

/**
 * Everything one thread's agent can run. The composer button, its popup and the
 * panel each hold one and share their answers, so the popup opens on the list
 * the button already counted while its own scan refreshes both.
 */
export function useSkillList(threadId: string) {
  const rpc = useRpc<RpcContract>();
  return useLoaded<SkillList>(threadId, () => rpc.call("list", { threadId }), skillLists);
}

export function useSkillDocument(threadId: string, skillId: string) {
  const rpc = useRpc<RpcContract>();
  return useLoaded<SkillDocument>(`${threadId}\n${skillId}`, () => rpc.call("read", { threadId, skillId }));
}

/**
 * **Add to chat**: puts the skill's command pill — the one bb's own `/` menu
 * inserts — at the start of the thread's composer draft without sending it,
 * then hands the screen back and focuses the composer. The draft's other
 * mentions and its attachments stay as they were. `useComposer()` writes to
 * the thread a slot is mounted for — the composer that opened the popup, the
 * thread's draft for the side panel — so the button is offered only when that
 * is this thread.
 */
export function useAddToChat(threadId: string, onAdded: () => void) {
  const composer = useComposer();
  return {
    canAdd: writesToThread(composer.scope, threadId),
    add(command: SkillCommand) {
      composer.replace((draft) => withSkillCommand(draft, command));
      onAdded();
      composer.focus();
    },
  };
}
