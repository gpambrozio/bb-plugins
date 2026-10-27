// @vitest-environment jsdom
/**
 * "Herald" in bb's thread menu: the rows on screen are read in one batch, each
 * row shows what applies to it and why, a pick is saved through the server,
 * and every row is read again when any choice changes.
 */
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadAction, PluginThreadActionRegistration } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_STORED_CONFIG, type RecentHistoryItem } from "../shared/herald";
import { CHOICES_CHANNEL, NO_CHOICE, type ChoiceInputs, type ChoiceOption } from "../shared/thread-choice";
import { THREAD_CHOICE_ACTION, type ThreadChoicesData } from "./thread-action";

afterEach(cleanup);

function target(id: string, parentThreadId: string | null = null, archivedAt: number | null = null) {
  return {
    id,
    projectId: "p1",
    parentThreadId,
    archivedAt,
    pinnedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle" as const,
    environment: null,
  };
}

/** The server's choices, as `choices.list` and `choices.set` see them, and every call made. */
function server(initial: Record<string, ChoiceInputs>) {
  const stored = { ...initial };
  const calls = { list: [] as string[][], set: [] as Array<{ threadId: string; choice: ChoiceOption }> };
  let failing: string | null = null;
  /**
   * While holding, each `choices.list` answers with the choices as they were
   * when it was called, but only once the test releases it.
   */
  let holding = false;
  const held: Array<() => void> = [];
  const handlers = {
    list: () => ({ entries: [] }),
    "config.get": () => DEFAULT_STORED_CONFIG,
    "config.set": () => DEFAULT_STORED_CONFIG,
    "history.list": () => ({ items: [] }),
    "history.recent": () => ({ items: [] as RecentHistoryItem[] }),
    "speech.voices": () => ({ available: false, voices: [] }),
    "speech.render": () => ({ mimeType: "audio/wav", base64: "" }),
    log: () => null,
    "choices.list": ({ threadIds }: { threadIds: string[] }) => {
      calls.list.push(threadIds);
      if (failing !== null) throw new Error(failing);
      const answer = { threads: Object.fromEntries(threadIds.flatMap((id) => (stored[id] === undefined ? [] : [[id, stored[id]]]))) };
      if (!holding) return answer;
      return new Promise<typeof answer>((resolve) => held.push(() => resolve(answer)));
    },
    "choices.set": (input: { threadId: string; choice: ChoiceOption }) => {
      calls.set.push(input);
      const before = stored[input.threadId] ?? NO_CHOICE;
      stored[input.threadId] = { ...before, own: input.choice === "default" ? null : input.choice };
      return stored[input.threadId] as ChoiceInputs;
    },
  };
  return {
    stored,
    calls,
    handlers,
    held,
    fail: (message: string | null) => (failing = message),
    hold: (on: boolean) => (holding = on),
  };
}

/** Renders the registration's `useData` as bb would, once for the app, and hands back what it returns. */
function mount(handlers: ReturnType<typeof server>["handlers"], threadIds: string[], settings: Record<string, boolean> = {}) {
  const registration = THREAD_CHOICE_ACTION as PluginThreadActionRegistration<ThreadChoicesData>;
  const seen: { data: ThreadChoicesData | null; show: (ids: string[]) => void } = { data: null, show: () => {} };
  function Probe() {
    const [shown, show] = useState(threadIds);
    seen.show = show;
    seen.data = registration.useData?.({ threadIds: shown }) ?? null;
    return null;
  }
  const slot = renderSlot<object, RpcContract>({ component: Probe }, {}, { rpc: handlers, settings });
  const item = (thread: ReturnType<typeof target>): PluginThreadAction | null => {
    if (seen.data === null) throw new Error("useData has not run");
    return registration.item({ thread, data: seen.data, sdk: {} as never, navigate: {} as never });
  };
  return { slot, seen, item };
}

function picks(action: PluginThreadAction | null) {
  return action?.choices?.items.map((choice) => [choice.label, choice.selected === true]);
}

describe("Herald's thread menu action", () => {
  it("joins bb's state group in every thread menu", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadActions.map((action) => [action.id, action.group, action.icon])).toEqual([
      ["announcements", "1_state", "herald/megaphone"],
    ]);
  });

  it("reads the rows on screen in one batch, and shows each row's choice and where it comes from", async () => {
    const fake = server({
      coord: { own: "questions", inherited: null },
      w1: { own: null, inherited: { choice: "questions", threadId: "coord", fromParent: true } },
      solo: NO_CHOICE,
    });
    const { seen, item } = mount(fake.handlers, ["coord", "w1", "solo"], { announceSubagents: true });
    await waitFor(() => expect(seen.data?.inputs.size).toBe(3));
    expect(fake.calls.list).toEqual([["coord", "w1", "solo"]]);

    const coord = item(target("coord"));
    expect(coord).toMatchObject({ label: "Herald", detail: "Questions only", icon: "MessageQuestion" });
    expect(coord?.choices?.hint).toBeUndefined();
    expect(picks(coord)).toEqual([
      ["Default", false],
      ["Announce", false],
      ["Questions only", true],
      ["Silent", false],
    ]);

    const worker = item(target("w1", "coord"));
    expect(worker).toMatchObject({ detail: "Questions only", choices: { hint: "Following the thread that started this one." } });
    expect(picks(worker)?.[0]).toEqual(["Default", true]);

    expect(item(target("solo"))).toMatchObject({ detail: "Announce", icon: "herald/megaphone" });
    expect(item(target("solo", null, 1))).toBeNull();
  });

  it("shows a child thread as Silent by default while subagents are not announced", async () => {
    const fake = server({ w1: NO_CHOICE });
    const { seen, item } = mount(fake.handlers, ["w1"]);
    await waitFor(() => expect(seen.data?.inputs.size).toBe(1));
    expect(item(target("w1", "coord"))).toMatchObject({
      detail: "Silent",
      icon: "herald/volume-off",
      choices: { hint: expect.stringContaining("speaks for it") },
    });
  });

  it("saves a pick through the server, and reads every row again", async () => {
    const fake = server({ coord: NO_CHOICE, w1: NO_CHOICE });
    const { seen, item } = mount(fake.handlers, ["coord", "w1"], { announceSubagents: true });
    await waitFor(() => expect(seen.data?.inputs.size).toBe(2));
    await act(async () => {
      await item(target("coord"))?.run({ value: "silent", requestRename: () => {} });
    });
    expect(fake.calls.set).toEqual([{ threadId: "coord", choice: "silent" }]);
    expect(fake.calls.list).toEqual([["coord", "w1"], ["coord", "w1"]]);
    expect(item(target("coord"))).toMatchObject({ detail: "Silent" });

    await act(async () => {
      await item(target("coord"))?.run({ value: "default", requestRename: () => {} });
    });
    expect(fake.calls.set.at(-1)).toEqual({ threadId: "coord", choice: "default" });
    expect(item(target("coord"))).toMatchObject({ detail: "Announce" });
  });

  it("reads every row again when another window changes a choice", async () => {
    const fake = server({ t1: NO_CHOICE });
    const { slot, seen, item } = mount(fake.handlers, ["t1"]);
    await waitFor(() => expect(seen.data?.inputs.size).toBe(1));
    fake.stored.t1 = { own: "silent", inherited: null };
    await slot.emitRealtime(CHOICES_CHANNEL, { at: 1 });
    await waitFor(() => expect(item(target("t1"))).toMatchObject({ detail: "Silent" }));
  });

  it("drops a read that started before a change and answers after it", async () => {
    const fake = server({ t1: NO_CHOICE });
    const { slot, seen, item } = mount(fake.handlers, ["t1"]);
    await waitFor(() => expect(seen.data?.inputs.size).toBe(1));
    fake.hold(true);
    // Another window's nudge starts a read that sees the old choice…
    await slot.emitRealtime(CHOICES_CHANNEL, { at: 1 });
    await waitFor(() => expect(fake.held).toHaveLength(1));
    // …and the user picks Silent here before it answers.
    let saved: Promise<void> | undefined;
    act(() => {
      saved = item(target("t1"))?.run({ value: "silent", requestRename: () => {} }) as Promise<void>;
    });
    await waitFor(() => expect(fake.held).toHaveLength(2));
    await act(async () => {
      fake.held[1]?.();
      await saved;
    });
    expect(item(target("t1"))).toMatchObject({ detail: "Silent" });
    await act(async () => fake.held[0]?.());
    expect(item(target("t1"))).toMatchObject({ detail: "Silent" });
  });

  it("keeps a row read while a full read was under way", async () => {
    const fake = server({ t1: NO_CHOICE, t2: { own: "questions", inherited: null } });
    const { slot, seen, item } = mount(fake.handlers, ["t1"]);
    await waitFor(() => expect(seen.data?.inputs.size).toBe(1));
    fake.hold(true);
    await slot.emitRealtime(CHOICES_CHANNEL, { at: 1 });
    await waitFor(() => expect(fake.held).toHaveLength(1));
    // A row scrolls into view: only it is read, and it answers first.
    act(() => seen.show(["t1", "t2"]));
    await waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.calls.list.at(-1)).toEqual(["t2"]);
    await act(async () => fake.held[1]?.());
    await waitFor(() => expect(item(target("t2"))).toMatchObject({ detail: "Questions only" }));
    await act(async () => fake.held[0]?.());
    expect(item(target("t2"))).toMatchObject({ detail: "Questions only" });
    expect(item(target("t1"))).toMatchObject({ detail: "Announce" });
  });

  it("says when the choices cannot be read, and offers Retry", async () => {
    const fake = server({ t1: { own: "questions", inherited: null } });
    fake.fail("bb is away");
    const { seen, item } = mount(fake.handlers, ["t1"]);
    await waitFor(() => expect(seen.data?.error).toBe("bb is away"));
    const failed = item(target("t1"));
    expect(failed).toMatchObject({ detail: "Unavailable", choices: { hint: "bb is away" } });
    expect(failed?.choices?.items.at(-1)).toEqual({ id: "retry", label: "Retry" });

    fake.fail(null);
    await act(async () => {
      await failed?.run({ value: "retry", requestRename: () => {} });
    });
    await waitFor(() => expect(item(target("t1"))).toMatchObject({ detail: "Questions only" }));
    expect(seen.data?.error).toBeNull();
  });
});
