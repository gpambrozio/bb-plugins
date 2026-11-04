import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../server";
import { type SkillDocument, type SkillList, type SkillSubject, subjectKey } from "../shared/skills";
import { type SkillCommand, withSkillCommand, writesToSubject } from "./insert";
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
 * one subject's skills never show under another's, and an answer still on its
 * way for the old key is dropped when it lands. A null key asks for nothing
 * and stays loading.
 *
 * With a `channel`, every holder of the same key shares its answers, failures
 * included: one that mounts starts from the last answer another holder has,
 * and each answer one holder gets reaches the rest, unless it was asked for
 * before one already out.
 */
function useLoaded<T>(
  key: string | null,
  load: () => Promise<T>,
  channel?: AnswerChannel<Loaded<T>>,
): { state: Loaded<T>; reload: () => void } {
  const initial = (): Loaded<T> => (key === null ? undefined : channel?.last(key)) ?? { status: "loading" };
  const [answer, setAnswer] = useState<{ key: string | null; state: Loaded<T> }>(() => ({ key, state: initial() }));
  const [generation, setGeneration] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (channel === undefined || key === null) return;
    return channel.subscribe(key, (state) => setAnswer({ key, state }));
  }, [channel, key]);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    const ticket = channel?.ticket() ?? 0;
    // Through the channel, this holder hears its own answer as a subscriber,
    // unless a newer one is already out.
    const settle = (state: Loaded<T>) => {
      if (!live) return;
      if (channel === undefined) setAnswer({ key, state });
      else channel.publish(key, state, ticket);
    };
    loadRef.current().then(
      (data) => settle({ status: "ready", data }),
      (error: unknown) => settle({ status: "error", message: messageOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [channel, key, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { state: answer.key === key ? answer.state : initial(), reload };
}

const skillLists = createAnswerChannel<Loaded<SkillList>>();

/**
 * Everything one thread's agent can run — or, in the new-thread composer, the
 * thread its selection would start; null while that is not known yet. The
 * composer button, its popup and the panel each hold one and share their
 * answers, so the popup opens on the list the button already counted while
 * its own scan refreshes both.
 */
export function useSkillList(subject: SkillSubject | null) {
  const rpc = useRpc<RpcContract>();
  const load = () => {
    // useLoaded asks for nothing under a null key, so this never runs then.
    if (subject === null) throw new Error("There is no thread to list skills for yet.");
    return rpc.call("list", subject);
  };
  return useLoaded<SkillList>(subject === null ? null : subjectKey(subject), load, skillLists);
}

export function useSkillDocument(subject: SkillSubject, skillId: string) {
  const rpc = useRpc<RpcContract>();
  return useLoaded<SkillDocument>(`${subjectKey(subject)}\n${skillId}`, () => rpc.call("read", { ...subject, skillId }));
}

/**
 * **Add to chat**: puts the skill's command pill — the one bb's own `/` menu
 * inserts — at the start of the composer draft without sending it, then
 * hands the screen back and focuses the composer. The draft's other mentions
 * and its attachments stay as they were. `useComposer()` writes to the
 * composer a slot is mounted for — the composer that opened the popup, the
 * thread's draft for the side panel — so the button is offered only when that
 * is the subject's.
 */
export function useAddToChat(subject: SkillSubject, onAdded: () => void) {
  const composer = useComposer();
  return {
    canAdd: writesToSubject(composer.scope, subject),
    add(command: SkillCommand) {
      composer.replace((draft) => withSkillCommand(draft, command));
      onAdded();
      composer.focus();
    },
  };
}
