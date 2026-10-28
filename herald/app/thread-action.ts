/**
 * "Herald" in bb's thread menu: per thread, Announce, Questions only, Silent,
 * or Default to follow the thread above it and Herald's settings. The choice
 * is stored on the thread by the server (`choices.set`), which also checks it
 * before it announces anything; the menu only shows and changes it. On bb
 * 0.48 the same list is in the menu of a sidebar selection, and sets every
 * selected thread at once (`choices.setMany`); bb 0.47 has no such menu.
 *
 * bb calls `useData` once for the whole app with the threads on screen, so
 * the choices are read in one batch for the rows not loaded yet, and read
 * again for every row when any choice changes — a thread's choice also
 * decides its workers' — or the connection comes back.
 */
import {
  experimental_THREAD_ACTION_GROUPS,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginThreadAction,
  type PluginThreadActionBulkItemInput,
  type PluginThreadActionChoices,
  type PluginThreadActionDataInput,
  type PluginThreadActionItemInput,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import { SETTINGS } from "../shared/settings";
import {
  CHOICE_LABELS,
  CHOICE_OPTIONS,
  CHOICES_BATCH_MAX,
  CHOICES_CHANNEL,
  ChoiceOptionSchema,
  effectiveChoice,
  NO_CHOICE,
  type ChoiceInputs,
  type ChoiceOption,
  type EffectiveChoice,
  type ThreadChoice,
} from "../shared/thread-choice";
import { HERALD_ICONS } from "./icons";

export interface ThreadChoicesData {
  /** Each thread read so far; a thread missing here has not been read yet. */
  inputs: ReadonlyMap<string, ChoiceInputs>;
  /** *Announce threads started by another thread*, which decides a child thread's default. */
  announceSubagents: boolean;
  /** Why the last read failed, until one succeeds. */
  error: string | null;
  setChoice(threadId: string, option: ChoiceOption): Promise<void>;
  /** The same choice for every thread of a selection. */
  setChoices(threadIds: readonly string[], option: ChoiceOption): Promise<void>;
  retry(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useThreadChoices({ threadIds }: PluginThreadActionDataInput): ThreadChoicesData {
  const rpc = useRpc<RpcContract>();
  const { values } = useSettings();
  const connection = useRealtimeConnectionState();
  const [inputs, setInputs] = useState<ReadonlyMap<string, ChoiceInputs>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(threadIds);
  shown.current = threadIds;
  /** Threads asked for already, so a row is read once until the next full read. */
  const requested = useRef(new Set<string>());
  /**
   * Bumped by every full read and every change: a read that started before
   * the latest one answers about an older state and is dropped.
   */
  const epoch = useRef(0);

  const read = useCallback(
    async (ids: readonly string[], full: boolean) => {
      if (full) {
        epoch.current += 1;
        requested.current = new Set(ids);
      }
      const started = epoch.current;
      if (ids.length === 0) return;
      try {
        const answered = new Map<string, ChoiceInputs>();
        for (let at = 0; at < ids.length; at += CHOICES_BATCH_MAX) {
          const { threads } = await rpc.call("choices.list", { threadIds: ids.slice(at, at + CHOICES_BATCH_MAX) });
          for (const [threadId, value] of Object.entries(threads)) answered.set(threadId, value);
        }
        if (started !== epoch.current) return;
        // Merged, never replaced: a row read meanwhile keeps its answer. A row
        // that left the screen is read again when it comes back.
        setInputs((current) => {
          const next = new Map(current);
          // A thread bb does not know has no choice to show.
          for (const threadId of ids) next.set(threadId, answered.get(threadId) ?? NO_CHOICE);
          return next;
        });
        setError(null);
      } catch (cause) {
        for (const threadId of ids) requested.current.delete(threadId);
        if (started === epoch.current) setError(errorText(cause));
      }
    },
    [rpc],
  );

  const readAll = useCallback(() => void read(shown.current, true), [read]);

  const key = threadIds.join("\n");
  useEffect(() => {
    const missing = shown.current.filter((threadId) => !requested.current.has(threadId));
    for (const threadId of missing) requested.current.add(threadId);
    if (missing.length > 0) void read(missing, false);
  }, [key, read]);

  useRealtime(CHOICES_CHANNEL, readAll);

  // A change made while the connection was down never arrives as a signal.
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") readAll();
    previous.current = connection;
  }, [connection, readAll]);

  /** Shows the pick at once; the read after the save puts right what did not land. */
  const showPicked = useCallback((threadIds: readonly string[], option: ChoiceOption) => {
    epoch.current += 1;
    setInputs((current) => {
      const next = new Map(current);
      for (const threadId of threadIds) {
        const before = current.get(threadId) ?? NO_CHOICE;
        next.set(threadId, { ...before, own: option === "default" ? null : option });
      }
      return next;
    });
  }, []);

  const setChoice = useCallback(
    async (threadId: string, option: ChoiceOption) => {
      showPicked([threadId], option);
      try {
        await rpc.call("choices.set", { threadId, choice: option });
      } catch (cause) {
        toast.error(`Herald could not save this thread's choice: ${errorText(cause)}`);
      }
      // Its workers may follow it; the server's nudge reaches the other windows.
      await read(shown.current, true);
    },
    [rpc, read, showPicked],
  );

  const setChoices = useCallback(
    async (threadIds: readonly string[], option: ChoiceOption) => {
      showPicked(threadIds, option);
      try {
        for (let at = 0; at < threadIds.length; at += CHOICES_BATCH_MAX) {
          await rpc.call("choices.setMany", { threadIds: threadIds.slice(at, at + CHOICES_BATCH_MAX), choice: option });
        }
      } catch (cause) {
        toast.error(`Herald could not save the choice for every selected thread: ${errorText(cause)}`);
      }
      await read(shown.current, true);
    },
    [rpc, read, showPicked],
  );

  const subagents = values?.announceSubagents;
  const announceSubagents = typeof subagents === "boolean" ? subagents : SETTINGS.announceSubagents.default;
  return useMemo(
    () => ({ inputs, announceSubagents, error, setChoice, setChoices, retry: readAll }),
    [inputs, announceSubagents, error, setChoice, setChoices, readAll],
  );
}

const CHOICE_ICONS: Record<ThreadChoice, string> = {
  announce: HERALD_ICONS.megaphone,
  questions: "MessageQuestion",
  silent: HERALD_ICONS.volumeOff,
};

/** Why the effective choice is not the thread's own, when it is not. */
function hintOf(effective: EffectiveChoice): string | undefined {
  switch (effective.source) {
    case "parent":
      return "Following the thread that started this one.";
    case "ancestor":
      return "Following a thread further up that started this one.";
    case "subagent":
      return "The thread that started this one speaks for it, unless Herald's settings announce such threads too.";
    case "self":
    case "default":
      return undefined;
  }
}

/** The list under "Herald": the four options, `selected` checked, and Retry while reads fail. */
function choiceList(selected: ChoiceOption | null, heading: string, hint: string | undefined, error: string | null): PluginThreadActionChoices {
  return {
    heading,
    ...(hint === undefined ? {} : { hint }),
    items: [
      ...CHOICE_OPTIONS.map((option) => ({
        id: option,
        label: CHOICE_LABELS[option],
        ...(option === "default" ? {} : { icon: CHOICE_ICONS[option] }),
        selected: selected === option,
      })),
      ...(error === null ? [] : [{ id: "retry", label: "Retry" }]),
    ],
  };
}

/** What a pick does: Retry reads again, and an option goes to `save`. */
function runPick(data: ThreadChoicesData, save: (option: ChoiceOption) => Promise<void>): PluginThreadAction["run"] {
  return async ({ value }) => {
    if (value === "retry") {
      data.retry();
      return;
    }
    const option = ChoiceOptionSchema.safeParse(value);
    if (option.success) await save(option.data);
  };
}

export function threadChoiceItem({ thread, data }: PluginThreadActionItemInput<ThreadChoicesData>): PluginThreadAction | null {
  if (thread.archivedAt !== null) return null;
  const inputs = data.inputs.get(thread.id);
  const effective = inputs === undefined ? null : effectiveChoice(inputs, thread.parentThreadId !== null, data.announceSubagents);
  const hint = data.error ?? (effective === null ? undefined : hintOf(effective));
  const detail = effective !== null ? CHOICE_LABELS[effective.choice] : data.error !== null ? "Unavailable" : undefined;
  return {
    label: "Herald",
    ...(detail === undefined ? {} : { detail }),
    icon: effective === null ? HERALD_ICONS.megaphone : CHOICE_ICONS[effective.choice],
    choices: choiceList(inputs === undefined ? null : (inputs.own ?? "default"), "What Herald announces", hint, data.error),
    run: runPick(data, (option) => data.setChoice(thread.id, option)),
  };
}

/**
 * "Herald" in the menu of a sidebar selection (bb 0.48): one pick for every
 * selected thread. An option is checked only when every thread has it as its
 * own, and the detail names what they announce only when they all agree.
 * Archived threads are left out, as their own menus leave Herald out.
 */
export function threadChoiceBulkItem({ threads, data }: PluginThreadActionBulkItemInput<ThreadChoicesData>): PluginThreadAction | null {
  const live = threads.filter((thread) => thread.archivedAt === null);
  if (live.length === 0) return null;
  const read = live.flatMap((thread) => {
    const inputs = data.inputs.get(thread.id);
    return inputs === undefined ? [] : [{ thread, inputs }];
  });
  const loaded = read.length === live.length;
  const own = new Set(read.map(({ inputs }) => inputs.own ?? "default"));
  const effective = new Set(
    read.map(({ thread, inputs }) => effectiveChoice(inputs, thread.parentThreadId !== null, data.announceSubagents).choice),
  );
  const agreed = loaded && effective.size === 1 ? [...effective][0] : undefined;
  const sharedPick = loaded && own.size === 1 ? ([...own][0] ?? null) : null;
  const detail = agreed !== undefined ? CHOICE_LABELS[agreed] : loaded ? "Mixed" : data.error !== null ? "Unavailable" : undefined;
  const hint = data.error ?? (live.length < threads.length ? "Archived threads are left out." : undefined);
  return {
    label: "Herald",
    ...(detail === undefined ? {} : { detail }),
    icon: agreed === undefined ? HERALD_ICONS.megaphone : CHOICE_ICONS[agreed],
    choices: choiceList(sharedPick, `What Herald announces for ${live.length} threads`, hint, data.error),
    run: runPick(data, (option) => data.setChoices(live.map((thread) => thread.id), option)),
  };
}

export const THREAD_CHOICE_ACTION: PluginThreadActionRegistration<ThreadChoicesData> = {
  id: "announcements",
  title: "Herald announcements",
  icon: HERALD_ICONS.megaphone,
  group: experimental_THREAD_ACTION_GROUPS.state,
  order: 60,
  useData: useThreadChoices,
  item: threadChoiceItem,
  experimental_bulkItem: threadChoiceBulkItem,
};
