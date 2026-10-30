/**
 * The whole server against the SDK's fake host: a thread event becomes an
 * entry with its sentence, and the app hears about it. Nothing here talks to
 * a running bb.
 */
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin, { ABANDONED_AFTER_MS } from "./server";
import { announceDrained } from "./server/reload-signal";
import type { AttentionEntry } from "./shared/herald";
import { DEFAULT_STORED_CONFIG, ENTRIES_CHANNEL, SENTENCES_CHANNEL, TOOL_COMMANDS } from "./shared/herald";
import { CHOICES_CHANNEL } from "./shared/thread-choice";

/**
 * A "tool" that answers with whether the prompt carried the request: real process, no model. It
 * holds its answer until the file `gate` exists, so a test sees the sentence pending for as long as
 * it needs, however slowly a loaded machine runs it.
 */
function gatedEchoTool(gate: string): string {
  const answer = "process.stdout.write(s.includes('Fix the login bug')?'Login fix is done; nothing is left for you.':'No request seen.')";
  const script = `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const t=setInterval(()=>{if(require('fs').existsSync(process.argv[1])){clearInterval(t);${answer}}},5)})`;
  return `"${process.execPath}" -e "${script}" "${gate}"`;
}
const SLOW_TOOL = `"${process.execPath}" -e "setTimeout(()=>{},60000)"`;

const USER_THREAD = makeThreadResponse({
  id: "thr_user",
  projectId: "prj_shop",
  environmentId: "env_1",
  title: "Login fix",
  latestAttentionAt: 2,
  lastReadAt: 1,
});

const OTHER_THREAD = makeThreadResponse({ id: "thr_other", projectId: "prj_shop", title: "Docs", latestAttentionAt: 2, lastReadAt: 1 });

/** A thread `USER_THREAD` started, for the choices a worker inherits. */
const WORKER_THREAD = makeThreadResponse({
  id: "thr_worker",
  projectId: "prj_shop",
  parentThreadId: USER_THREAD.id,
  title: "Worker",
  latestAttentionAt: 2,
  lastReadAt: 1,
});

const KNOWN_THREADS = [USER_THREAD, OTHER_THREAD, WORKER_THREAD];

/**
 * Plugin metadata on the known threads, kept the way bb keeps it, for the
 * thread menu's choice: the batched read, the ancestors, and the update.
 */
function metadataStubs() {
  const metadata = new Map<string, Record<string, unknown>>();
  /**
   * Set `ancestors` to make bb's ancestor read fail, as a lost connection
   * would; name threads in `updates` to make their metadata writes fail.
   */
  const failures = { ancestors: false, updates: new Set<string>() };
  const ancestorsOf = (threadId: string) => {
    const ids: string[] = [];
    for (let at = KNOWN_THREADS.find((known) => known.id === threadId)?.parentThreadId ?? null; at !== null; ) {
      ids.push(at);
      at = KNOWN_THREADS.find((known) => known.id === at)?.parentThreadId ?? null;
    }
    return ids;
  };
  const stubs = {
    experimental_listAncestors: async ({ threadIds }: { threadIds: readonly string[] }) => {
      if (failures.ancestors) throw new Error("bb is away");
      return {
        threads: threadIds
          .filter((id) => KNOWN_THREADS.some((known) => known.id === id))
          .map((threadId) => ({ threadId, ancestorIds: ancestorsOf(threadId) })),
      };
    },
    experimental_listPluginMetadata: async ({ threadIds }: { threadIds: readonly string[] }) => ({
      threads: threadIds.flatMap((threadId) => {
        const value = metadata.get(threadId);
        return value === undefined ? [] : [{ threadId, metadata: value }];
      }),
    }),
    updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
      if (failures.updates.has(threadId)) throw new Error("thread not found");
      const next = { ...metadata.get(threadId), ...set };
      for (const key of remove ?? []) delete next[key];
      if (Object.keys(next).length === 0) metadata.delete(threadId);
      else metadata.set(threadId, next);
      return next;
    },
  };
  return { metadata, failures, stubs };
}

/**
 * bb's push-notifications plugin as Herald reaches it through `bb.sdk.plugins`:
 * the per-thread levels, the send, its settings and whether it is there. No
 * real level is changed and nothing is sent.
 */
function pushStubs() {
  const levels = new Map<string, string>();
  const sent: Array<{ title: string; body?: string; threadId?: string }> = [];
  const state = { available: true };
  const stubs = {
    experimental_discoverRpc: async () =>
      state.available
        ? [
            {
              pluginId: "push-notifications",
              method: "notifications.send",
              displayName: "Push notifications",
              inputSchema: {},
              outputSchema: {},
              methodDescription: null,
              registrationDescription: null,
            },
          ]
        : [],
    getSettings: async () => ({ ok: true as const, schema: {}, values: { defaultLevel: "all", childLevel: "input-only" } }),
    callRpc: async ({ method, input }: { method: string; input?: unknown }) => {
      const args = input as { threadIds?: string[]; threadId?: string; level?: string; title?: string; body?: string };
      switch (method) {
        case "threadNotifications.list":
          return {
            threads: Object.fromEntries(
              (args.threadIds ?? []).flatMap((id) => {
                const own = levels.get(id);
                return own === undefined ? [] : [[id, { own, ancestorCap: null }]];
              }),
            ),
          };
        case "threadNotifications.set":
          if (args.level === "inherit") levels.delete(args.threadId ?? "");
          else levels.set(args.threadId ?? "", args.level ?? "");
          return { own: args.level, ancestorCap: null };
        case "notifications.send":
          sent.push({ title: args.title ?? "", body: args.body, threadId: args.threadId });
          return { ok: true, channels: ["desktop"] };
        default:
          throw new Error(`No such method: ${method}`);
      }
    },
  };
  return { levels, sent, state, stubs };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The top-level messages of every thread's timeline, as `threads.timeline` serves them; one page, one turn. */
let timelineMessages: Array<{ id: string; createdAt: number; role: "user" | "assistant"; initiator: "user" | null }> = [];

async function load(settings: Record<string, string | number | boolean> = {}) {
  const { metadata, failures, stubs } = metadataStubs();
  const push = pushStubs();
  const host = createFakePluginHost({
    pluginId: "herald",
    settings,
    sdk: {
      projects: { get: async () => ({ id: "prj_shop", name: "Shop" }) as never },
      environments: { get: async () => ({ id: "env_1", path: "/Users/me/shop" }) as never },
      plugins: push.stubs as never,
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          KNOWN_THREADS.find((known) => known.id === threadId) ?? makeThreadResponse({ id: threadId }),
        ...stubs,
        promptHistory: async () =>
          [{ id: "m1", createdAt: 1, input: [{ type: "text", text: "Fix the login bug", mentions: [] }] }] as never,
        interactions: { list: async () => [], get: async () => ({ status: "pending" }) as never },
        timeline: async () =>
          ({
            rows: timelineMessages.map((message) => ({
              kind: "conversation",
              ...message,
              turnId: "turn_1",
              turnRequest: message.role === "user" ? { isGrouped: false, kind: "message", status: "accepted" } : null,
            })),
            timelinePage: { olderCursor: null },
          }) as never,
      },
    },
  });
  await plugin(host.bb);
  live.push(host);
  return Object.assign(host, { metadata, failures, push });
}

/** Every host a test made: instances of one plugin share in-process channels, so each test disposes its own. */
const live: Array<{ harness: { lifecycle: { dispose(): Promise<void> } } }> = [];

function track<T extends { harness: { lifecycle: { dispose(): Promise<void> } } }>(host: T): T {
  live.push(host);
  return host;
}

function entriesOf(result: unknown): AttentionEntry[] {
  return (result as { entries: AttentionEntry[] }).entries;
}

describe("herald server", () => {
  afterEach(async () => {
    await Promise.all(live.splice(0).map((host) => host.harness.lifecycle.dispose().catch(() => {})));
    timelineMessages = [];
  });

  it("announces a finished turn with its plain sentence, tells the app, and starts no thread", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    const [entry] = entriesOf(await harness.callRpc("list", {}));
    expect(entry).toMatchObject({
      threadId: "thr_user",
      reason: "finished",
      projectName: "Shop",
      lastRequest: "Fix the login bug",
      summary: { status: "ready", text: "Login fix finished. I fixed auth.ts." },
    });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === ENTRIES_CHANNEL)).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("reaches bb for nothing while it loads", async () => {
    const { harness } = await load();
    await settle();
    expect(harness.sdk.calls).toEqual([]);
  });

  it("lists a switched-off kind without announcing it", async () => {
    const { harness } = await load({ announceQuestions: false });
    await harness.emitThreadEvent("interaction.pending", {
      thread: USER_THREAD,
      interaction: {
        createdAt: 1,
        id: "int_1",
        payload: { kind: "user_question", questions: [{ id: "q", prompt: "Ship it?", allowFreeText: true, multiSelect: false, required: true }] },
        providerId: "claude-code",
        providerRequestId: "r",
        providerThreadId: "p",
        resolution: null,
        resolvedAt: null,
        status: "pending",
        statusReason: null,
        threadId: USER_THREAD.id,
        turnId: "turn",
      },
    });
    await settle();
    const [entry] = entriesOf(await harness.callRpc("list", {}));
    expect(entry).toMatchObject({ reason: "question", headline: "Ship it?", summary: { status: "off" } });
  });

  it("stores a thread's choice in its own metadata, and tells every open menu", async () => {
    const { harness, metadata } = await load();
    expect(await harness.callRpc("choices.set", { threadId: USER_THREAD.id, choice: "questions" })).toEqual({ own: "questions", inherited: null });
    expect(metadata.get(USER_THREAD.id)).toEqual({ announce: "questions" });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === CHOICES_CHANNEL)).toHaveLength(1);
    expect(await harness.callRpc("choices.list", { threadIds: [USER_THREAD.id, WORKER_THREAD.id, "thr_unknown"] })).toEqual({
      threads: {
        [USER_THREAD.id]: { own: "questions", inherited: null },
        [WORKER_THREAD.id]: { own: null, inherited: { choice: "questions", threadId: USER_THREAD.id, fromParent: true } },
      },
    });
    await harness.callRpc("choices.set", { threadId: USER_THREAD.id, choice: "default" });
    expect(metadata.has(USER_THREAD.id)).toBe(false);
  });

  it("tells every open menu about a saved choice even when reading it back fails", async () => {
    const { harness, metadata, failures } = await load();
    failures.ancestors = true;
    await expect(harness.callRpc("choices.set", { threadId: USER_THREAD.id, choice: "silent" })).rejects.toThrow();
    expect(metadata.get(USER_THREAD.id)).toEqual({ announce: "silent" });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === CHOICES_CHANNEL)).toHaveLength(1);
  });

  it("stores one choice on several threads, and tells every open menu once", async () => {
    const { harness, metadata } = await load();
    expect(await harness.callRpc("choices.setMany", { threadIds: [USER_THREAD.id, OTHER_THREAD.id], choice: "silent" })).toBeNull();
    expect(metadata.get(USER_THREAD.id)).toEqual({ announce: "silent" });
    expect(metadata.get(OTHER_THREAD.id)).toEqual({ announce: "silent" });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === CHOICES_CHANNEL)).toHaveLength(1);
    await harness.callRpc("choices.setMany", { threadIds: [USER_THREAD.id, OTHER_THREAD.id], choice: "default" });
    expect(metadata.size).toBe(0);
  });

  it("saves the rest of a selection when one thread fails, says so, and still tells the menus", async () => {
    const { harness, metadata, failures } = await load();
    failures.updates.add(USER_THREAD.id);
    await expect(
      harness.callRpc("choices.setMany", { threadIds: [USER_THREAD.id, OTHER_THREAD.id, WORKER_THREAD.id], choice: "questions" }),
    ).rejects.toThrow(/1 of 3 threads were not saved/);
    expect(metadata.has(USER_THREAD.id)).toBe(false);
    expect(metadata.get(OTHER_THREAD.id)).toEqual({ announce: "questions" });
    expect(metadata.get(WORKER_THREAD.id)).toEqual({ announce: "questions" });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === CHOICES_CHANNEL)).toHaveLength(1);
  });

  it("checks the thread's choice before it announces", async () => {
    const { harness } = await load({ announceSubagents: true });
    await harness.callRpc("choices.set", { threadId: USER_THREAD.id, choice: "silent" });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    // The worker follows the thread that started it.
    await harness.emitThreadEvent("thread.idle", { thread: WORKER_THREAD, lastAssistantText: "Tests pass." });
    await harness.emitThreadEvent("thread.idle", { thread: OTHER_THREAD, lastAssistantText: "Docs updated." });
    await settle();
    const status = Object.fromEntries(entriesOf(await harness.callRpc("list", {})).map((entry) => [entry.threadId, entry.summary.status]));
    expect(status).toEqual({ [USER_THREAD.id]: "off", [WORKER_THREAD.id]: "off", [OTHER_THREAD.id]: "ready" });
  });

  it("keeps the voices it is given, and falls back to defaults", async () => {
    const { harness } = await load();
    expect(await harness.callRpc("config.get", {})).toEqual(DEFAULT_STORED_CONFIG);
    await harness.callRpc("config.set", { voices: { say: "Zoe (Premium)", web: "" } });
    expect(await harness.callRpc("config.get", {})).toEqual({ ...DEFAULT_STORED_CONFIG, voices: { say: "Zoe (Premium)", web: "" } });
  });

  it("keeps the sentence when the thread starts a new turn, and when the user has read the thread", async () => {
    const { harness } = await load({ announceFinished: false });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    expect(entriesOf(await harness.callRpc("list", {}))).toHaveLength(1);
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    expect(entriesOf(await harness.callRpc("list", {}))).toHaveLength(1);
    // USER_THREAD is read (lastReadAt 1 < latestAttentionAt 2 says unread; flip it) — still listed.
    await harness.emitThreadEvent("thread.active", { thread: { ...USER_THREAD, lastReadAt: 10 } });
    expect(entriesOf(await harness.callRpc("list", {}))).toHaveLength(1);
  });

  it("takes back a sentence still being written when the thread starts a new turn", async () => {
    const { harness } = await load({ writeWithModel: true });
    await harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    expect(entriesOf(await harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    expect(entriesOf(await harness.callRpc("list", {}))).toEqual([]);
  });

  it("keeps its entries across a reload, even one written while the reload ran", async () => {
    const host = await load({ announceFinished: false });
    // No wait for the write to land: the replacement loads first, and reads
    // storage again once the old instance says it has drained.
    await host.harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    const reloaded = track(await host.harness.lifecycle.reload(plugin));
    await settle();
    expect(entriesOf(await reloaded.harness.callRpc("list", {})).map((entry) => entry.threadId)).toEqual(["thr_user"]);
  });

  it("has the configured tool write the sentence, listing the plain one while it does", async () => {
    const gateDir = mkdtempSync(join(tmpdir(), "herald-gate-"));
    const gate = join(gateDir, "open");
    try {
      const { harness } = await load({ writeWithModel: true });
      await harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: gatedEchoTool(gate) });
      await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
      await settle();
      const [pending] = entriesOf(await harness.callRpc("list", {}));
      expect(pending?.summary).toEqual({ status: "pending", fallback: "Login fix finished. I fixed auth.ts." });
      writeFileSync(gate, "");
      await vi.waitFor(async () => {
        const [entry] = entriesOf(await harness.callRpc("list", {}));
        expect(entry?.summary).toEqual({ status: "ready", text: "Login fix is done; nothing is left for you." });
      });
      expect(harness.realtimeSignals.filter((signal) => signal.channel === ENTRIES_CHANNEL)).toHaveLength(2);
      expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    } finally {
      rmSync(gateDir, { recursive: true, force: true });
    }
  });

  it("says nothing and remembers nothing for a finished turn the tool answered with nothing", async () => {
    const { harness } = await load({ writeWithModel: true });
    await harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: `"${process.execPath}" -e "process.exit(0)"` });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Captain, shipshape." });
    await vi.waitFor(async () => {
      expect(entriesOf(await harness.callRpc("list", {})).map((entry) => entry.summary)).toEqual([{ status: "quiet", attentionAt: USER_THREAD.latestAttentionAt }]);
      expect(harness.realtimeSignals.filter((signal) => signal.channel === ENTRIES_CHANNEL)).toHaveLength(2);
    });
    expect(await harness.callRpc("history.list", { threadId: "thr_user" })).toEqual({ items: [] });
    // The turn's end still tells the thread's timeline to place its sentences again: a question's may move to the answer.
    expect(harness.realtimeSignals.filter((signal) => signal.channel === SENTENCES_CHANNEL)).toEqual([
      { channel: SENTENCES_CHANNEL, payload: { threadId: "thr_user" } },
    ]);
  });

  it("tells a thread's timeline to place its sentences again when a turn fails", async () => {
    const { harness } = await load({ announceErrors: false });
    await harness.emitThreadEvent("thread.failed", { thread: USER_THREAD, error: "Rate limited" });
    expect(harness.realtimeSignals).toContainEqual({ channel: SENTENCES_CHANNEL, payload: { threadId: "thr_user" } });
  });

  it("drops, unspoken, a sentence the instance before it was still writing — a question answered meanwhile included", async () => {
    const host = await load({ writeWithModel: true });
    await host.harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await host.harness.emitThreadEvent("interaction.pending", {
      thread: USER_THREAD,
      interaction: {
        createdAt: 1,
        id: "int_1",
        payload: { kind: "user_question", questions: [{ id: "q", prompt: "Ship it?", allowFreeText: true, multiSelect: false, required: true }] },
        providerId: "claude-code",
        providerRequestId: "r",
        providerThreadId: "p",
        resolution: null,
        resolvedAt: null,
        status: "pending",
        statusReason: null,
        threadId: USER_THREAD.id,
        turnId: "turn",
      },
    });
    await settle();
    expect(entriesOf(await host.harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
    // The replacement never promotes what it did not write: nothing to announce, nothing to resurrect.
    const reloaded = track(await host.harness.lifecycle.reload(plugin));
    await settle();
    expect(entriesOf(await reloaded.harness.callRpc("list", {}))).toEqual([]);
    expect(reloaded.harness.sdk.callsTo("threads.interactions.get")).toEqual([]);
  });

  it("starts the custom command from the tool selected before, in the answer to the save itself", async () => {
    const { harness } = await load();
    await harness.callRpc("config.set", { sentenceTool: "codex" });
    expect(await harness.callRpc("config.set", { sentenceTool: "custom" })).toMatchObject({ sentenceTool: "custom", sentenceCommand: TOOL_COMMANDS.codex });
    // Cleared while on custom: stays blank.
    expect(await harness.callRpc("config.set", { sentenceCommand: "" })).toMatchObject({ sentenceCommand: "" });
  });

  it("keeps the voices when the model settings are saved, and the other way round", async () => {
    const { harness } = await load();
    await harness.callRpc("config.set", { voices: { say: "Zoe (Premium)", web: "" } });
    await harness.callRpc("config.set", { sentencePrompt: "Say: {{headline}}" });
    expect(await harness.callRpc("config.get", {})).toEqual({
      ...DEFAULT_STORED_CONFIG,
      voices: { say: "Zoe (Premium)", web: "" },
      sentencePrompt: "Say: {{headline}}",
    });
  });

  it("keeps each thread's past sentences for its panel, and forgets a deleted thread", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "And the tests pass." });
    await settle();
    const { items } = (await harness.callRpc("history.list", { threadId: "thr_user" })) as { items: Array<{ text: string }> };
    expect(items.map((item) => item.text)).toEqual(["Login fix finished. And the tests pass.", "Login fix finished. I fixed auth.ts."]);
    await harness.emitThreadEvent("thread.deleted", { thread: USER_THREAD });
    await settle();
    expect(await harness.callRpc("history.list", { threadId: "thr_user" })).toEqual({ items: [] });
  });

  it("places each sentence on the message that led to it as soon as it is saved, and keeps the place", async () => {
    const { harness } = await load();
    timelineMessages = [
      { id: "m_prompt", createdAt: Date.now() - 2000, role: "user", initiator: "user" },
      { id: "m_answer", createdAt: Date.now() - 1000, role: "assistant", initiator: null },
    ];
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await vi.waitFor(async () =>
      expect(await harness.callRpc("history.placed", { threadId: "thr_user" })).toEqual({
        sentences: [expect.objectContaining({ text: "Login fix finished. I fixed auth.ts.", reason: "finished", messageId: "m_answer" })],
      }),
    );
    // Once saved, its thread hears so; the turn's end told it too.
    expect(harness.realtimeSignals.filter((signal) => signal.channel === SENTENCES_CHANNEL).length).toBeGreaterThanOrEqual(2);
    // Kept with the sentence: the timeline is not read again for it.
    timelineMessages = [];
    await settle();
    expect(await harness.callRpc("history.placed", { threadId: "thr_user" })).toMatchObject({ sentences: [{ messageId: "m_answer" }] });
    const { items } = (await harness.callRpc("history.list", { threadId: "thr_user" })) as { items: Array<{ messageId?: string | null }> };
    expect(items.map((item) => item.messageId)).toEqual(["m_answer"]);
  });

  it("lists the newest sentences of every thread for the Herald page, as many as configured", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    await harness.emitThreadEvent("thread.idle", { thread: OTHER_THREAD, lastAssistantText: "Wrote the guide." });
    await settle();
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "And the tests pass." });
    await settle();
    type Recent = { items: Array<{ threadId: string; threadTitle: string | null; projectName: string | null; threadExists: boolean; text: string }> };
    const all = (await harness.callRpc("history.recent", {})) as Recent;
    expect(all.items.map(({ threadId, threadTitle, projectName, threadExists, text }) => ({ threadId, threadTitle, projectName, threadExists, text }))).toEqual([
      { threadId: "thr_user", threadTitle: "Login fix", projectName: "Shop", threadExists: true, text: "Login fix finished. And the tests pass." },
      { threadId: "thr_other", threadTitle: "Docs", projectName: "Shop", threadExists: true, text: "Docs finished. Wrote the guide." },
      { threadId: "thr_user", threadTitle: "Login fix", projectName: "Shop", threadExists: true, text: "Login fix finished. I fixed auth.ts." },
    ]);

    const signals = harness.realtimeSignals.length;
    expect(await harness.callRpc("config.set", { recentHistoryLimit: 2 })).toMatchObject({ recentHistoryLimit: 2 });
    // An open page re-reads at its new length.
    expect(harness.realtimeSignals.slice(signals).map((signal) => signal.channel)).toEqual([ENTRIES_CHANNEL]);
    expect(((await harness.callRpc("history.recent", {})) as Recent).items.map((item) => item.threadId)).toEqual(["thr_user", "thr_other"]);

    await harness.emitThreadEvent("thread.deleted", { thread: USER_THREAD });
    await settle();
    expect(((await harness.callRpc("history.recent", {})) as Recent).items.map((item) => item.threadId)).toEqual(["thr_other"]);
  });

  it("tells an open page when a deleted thread's sentences go, though archiving already took its entry", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    await harness.emitThreadEvent("thread.archived", { thread: USER_THREAD });
    await settle();
    expect(((await harness.callRpc("history.recent", {})) as { items: unknown[] }).items).toHaveLength(1);
    const signals = harness.realtimeSignals.length;
    await harness.emitThreadEvent("thread.deleted", { thread: USER_THREAD });
    await settle();
    expect(harness.realtimeSignals.slice(signals).map((signal) => signal.channel)).toContain(ENTRIES_CHANNEL);
    expect(await harness.callRpc("history.recent", {})).toEqual({ items: [] });
  });

  it("lists 20 by default, refuses a length out of bounds, and reads an unreadable one as the default", async () => {
    const { bb, harness } = await load();
    expect(await harness.callRpc("config.get", {})).toMatchObject({ recentHistoryLimit: 20 });
    await expect(harness.callRpc("config.set", { recentHistoryLimit: 0 })).rejects.toThrow();
    await expect(harness.callRpc("config.set", { recentHistoryLimit: 51 })).rejects.toThrow();
    await expect(harness.callRpc("config.set", { recentHistoryLimit: 2.5 })).rejects.toThrow();
    await harness.callRpc("config.set", { recentHistoryLimit: 50 });
    expect(await harness.callRpc("config.get", {})).toMatchObject({ recentHistoryLimit: 50 });
    // A configuration saved before the setting existed has none.
    const { recentHistoryLimit: _, ...older } = DEFAULT_STORED_CONFIG;
    await bb.storage.kv.set("config", older);
    expect(await harness.callRpc("config.get", {})).toEqual(DEFAULT_STORED_CONFIG);
  });

  it("still drops what the instance before left when the read after its drain fails once", async () => {
    const host = await load({ writeWithModel: true });
    await host.harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await host.harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The replacement's second read of storage — the one after the drain — fails.
      const reloaded = track(
        await host.harness.lifecycle.reload((bb) => {
          const kv = bb.storage.kv;
          const list = kv.list.bind(kv);
          let reads = 0;
          kv.list = async (prefix?: string) => {
            reads += 1;
            if (reads === 2) throw new Error("kv away");
            return list(prefix);
          };
          return plugin(bb);
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(entriesOf(await reloaded.harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
      await vi.advanceTimersByTimeAsync(ABANDONED_AFTER_MS);
      expect(entriesOf(await reloaded.harness.callRpc("list", {}))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both of two saves made at once", async () => {
    const { harness } = await load();
    await Promise.all([harness.callRpc("config.set", { sentenceTool: "codex" }), harness.callRpc("config.set", { sentencePrompt: "Say: {{headline}}" })]);
    expect(await harness.callRpc("config.get", {})).toMatchObject({ sentenceTool: "codex", sentencePrompt: "Say: {{headline}}" });
  });

  it("does not give up on a sentence it is itself still writing when the instance before it drains", async () => {
    const { harness, bb } = await load({ writeWithModel: true });
    await harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    expect(entriesOf(await harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
    announceDrained(bb.pluginId, "the-instance-before");
    await settle();
    expect(entriesOf(await harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
  });

  describe("with Herald's sentences as push notifications", () => {
    /** Loaded with the switch on, past the wait for an instance before it. */
    async function loadPushing(settings: Record<string, string | number | boolean> = {}) {
      const host = await load({ pushSentences: true, ...settings });
      announceDrained(host.bb.pluginId, "the-instance-before");
      await settle();
      return host;
    }

    it("mutes bb for an announced thread as its turn starts, and sends the turn's end with Herald's sentence, opening that thread", async () => {
      const { harness, push } = await loadPushing();
      await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await settle();
      expect(push.levels.get(USER_THREAD.id)).toBe("muted");
      await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
      await settle();
      expect(push.sent).toEqual([{ title: "Login fix · Shop", body: "Login fix finished. I fixed auth.ts.", threadId: USER_THREAD.id }]);
      expect(await harness.callRpc("push.status", {})).toEqual({ state: "on", message: null });
    });

    it("gives the level back when the switch goes off, and when the thread is set to Silent", async () => {
      const host = await loadPushing();
      await host.harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await host.harness.emitThreadEvent("thread.active", { thread: OTHER_THREAD });
      await settle();
      await host.harness.callRpc("choices.set", { threadId: OTHER_THREAD.id, choice: "silent" });
      await settle();
      expect([...host.push.levels]).toEqual([[USER_THREAD.id, "muted"]]);
      await host.harness.setSettings({ pushSentences: false });
      await settle();
      expect(host.push.levels.size).toBe(0);
    });

    it("gives an archived thread back, and takes it over again once unarchived", async () => {
      const { harness, push } = await loadPushing();
      await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await settle();
      expect(push.levels.get(USER_THREAD.id)).toBe("muted");
      await harness.emitThreadEvent("thread.archived", { thread: USER_THREAD });
      await settle();
      expect(push.levels.has(USER_THREAD.id)).toBe(false);
      await harness.emitThreadEvent("thread.unarchived", { thread: USER_THREAD });
      await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await settle();
      expect(push.levels.get(USER_THREAD.id)).toBe("muted");
    });

    it("gives every level back when Herald unloads", async () => {
      const { harness, push } = await loadPushing();
      await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await settle();
      await harness.lifecycle.dispose();
      expect(push.levels.size).toBe(0);
    });

    it("changes no level when bb cannot send, and says why on the Herald page", async () => {
      const { harness, push } = await load({ pushSentences: true });
      push.state.available = false;
      announceDrained("herald", "the-instance-before");
      await settle();
      await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
      await settle();
      expect(push.levels.size).toBe(0);
      expect(push.sent).toEqual([]);
      expect(await harness.callRpc("push.status", {})).toMatchObject({ state: "unavailable" });
    });

    it("touches no level before the instance before it has had its last word", async () => {
      const { harness, push } = await load({ pushSentences: true });
      await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await settle();
      expect(push.levels.size).toBe(0);
    });

    it("reaches bb's notifications for nothing while the switch is off", async () => {
      const { harness } = await load();
      announceDrained("herald", "the-instance-before");
      await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
      await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
      await settle();
      expect(harness.sdk.calls.filter((call) => call.path.startsWith("plugins."))).toEqual([]);
    });
  });
});
