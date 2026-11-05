import { fileURLToPath } from "node:url";

import { createFakePluginHost, experimental_scanPublicSdkOnly, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import { BRIEF_CORE } from "./server/content";
import { listEvents, type EventListInput } from "./server/testing/event-log";
import { TOOL_NAMES } from "./server/tools";
import type { ThreadView } from "./shared/types";

const WORK = "thr_work";
const FORK = "thr_fork";

/**
 * The plugin over the fake host, with bb's SDK and its Git and PR Status plugins stubbed: a Claude Code
 * thread in `env_1` whose HEAD moves from `aaa` to `bbb` with one commit.
 */
async function setup(options: { providerCanFork?: boolean } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
  const threads = new Map([[WORK, makeThreadResponse({ id: WORK, projectId: "proj_1", providerId: "claude-code", environmentId: "env_1", title: "Add median", status: "idle" })]]);
  let head = "aaa";
  const metadata = new Map<string, Record<string, unknown>>();
  const stub = harness.sdk.stub.bind(harness.sdk);
  stub("threads.get", ({ threadId }: { threadId: string }) => {
    const thread = threads.get(threadId);
    if (thread === undefined) throw new Error("not found");
    return thread;
  });
  stub("projects.get", () => ({ id: "proj_1", name: "calc", gitRemoteUrl: "git@github.com:acme/calc.git" }));
  stub("environments.get", () => ({ id: "env_1", path: "/work/calc" }));
  const events = [{ seq: 1, createdAt: 1, turnId: "t1", type: "turn/completed", data: { status: "completed" } }];
  stub("threads.events.list", (input: EventListInput) => listEvents(events, input));
  stub("threads.interactions.list", () => []);
  stub("providers.list", () => [
    { id: "claude-code", capabilities: { supportsFork: options.providerCanFork ?? true } },
    { id: "acp-cursor", capabilities: { supportsFork: false } },
  ]);
  stub("plugins.callRpc", ({ pluginId, method, input }: { pluginId: string; method: string; input: { mergeBaseBranch?: string } }) => {
    if (pluginId === "bb--github-pr-status") return {};
    if (pluginId !== "bb--git" || method !== "workspaceStatus") throw new Error(`unexpected ${pluginId}.${method}`);
    const mergeBase =
      input.mergeBaseBranch === "aaa" ? { commits: [{ sha: "bbb", shortSha: "bbb", subject: "Add median" }], files: [{ path: "calc.py", status: "M" }] } : null;
    return { outcome: "available", workspace: { checkout: { headSha: head }, mergeBase } };
  });
  stub("threads.fork", (request: { sourceThreadId: string; pluginMetadata: Record<string, unknown> }) => {
    threads.set(FORK, makeThreadResponse({ id: FORK, projectId: "proj_1", providerId: "claude-code", environmentId: "env_1", originPluginId: "learning-exercises", sourceThreadId: request.sourceThreadId }));
    metadata.set(FORK, request.pluginMetadata);
    return threads.get(FORK);
  });
  stub("threads.send", () => ({ ok: true }));
  stub("threads.getPluginMetadata", ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {});
  await plugin(bb);
  const commitTurn = async () => {
    await harness.emitThreadEvent("thread.active", { thread: { ...threads.get(WORK)!, status: "active" } });
    head = "bbb";
    await harness.emitThreadEvent("thread.idle", { thread: threads.get(WORK)!, lastAssistantText: "Done." });
  };
  return { bb, harness, threads, metadata, commitTurn };
}

describe("zero context until a session starts", () => {
  it("ships no skills and contributes no instructions", async () => {
    const { harness } = await setup();
    expect(harness.registrations.instructionProvider).toBeNull();
    expect(harness.registrations.agentTools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    const plain = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: WORK } }));
    expect(plain).toEqual({ tools: [], skills: [], instructions: null });
  });

  it("metadata naming no open session unlocks nothing", async () => {
    const { harness } = await setup();
    const forged = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_x" }, pluginMetadata: { session: "ses_made_up" } }));
    expect(forged).toEqual({ tools: [], skills: [], instructions: null });
  });

  it("the package imports only public SDK entry points and has no skills folder", async () => {
    const allow = [
      /^@\//,
      /^react(-dom)?(\/.*)?$/,
      /^@radix-ui\//,
      /^(sonner|vaul|clsx|tailwind-merge|class-variance-authority|ignore|better-sqlite3|zod|micromark)$/,
      /^(vitest|vitest\/config|@testing-library\/react|@testing-library\/dom)$/,
    ];
    const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), { allow });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
    const { existsSync } = await import("node:fs");
    expect(existsSync(fileURLToPath(new URL("./skills", import.meta.url)))).toBe(false);
  });
});

describe("from a commit to an answered question", () => {
  it("offers after a commit, forks on Start, gives the fork the tools, and runs the card", async () => {
    const { harness, commitTurn, metadata } = await setup();
    await commitTurn();
    const view = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    expect(view.offer).toMatchObject({ trigger: "commit", topic: '"Add median"' });
    expect(view.eligible).toBe(true);

    await harness.callRpc("offerSeen", { offerId: view.offer!.id });
    const started = (await harness.callRpc("answerOffer", { offerId: view.offer!.id, answer: "start" })) as { threadId: string };
    expect(started.threadId).toBe(FORK);
    const [fork] = harness.sdk.callsTo("threads.fork") as [Record<string, unknown>][];
    expect(fork![0]).toMatchObject({
      sourceThreadId: WORK,
      title: "Learning: Add median",
      environment: { type: "reuse", environmentId: "env_1" },
      input: [{ type: "text", text: 'Learning exercise on "Add median" (commit bbb).' }],
    });
    const seed = (fork![0] as { agentContextSeed: { visibility: string; text: string }[] }).agentContextSeed;
    expect(seed).toHaveLength(1);
    expect(seed[0]!.visibility).toBe("agent-only");
    expect(seed[0]!.text.startsWith(BRIEF_CORE.trim())).toBe(true);
    // The work thread was not sent anything.
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);

    const forkConfig = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: FORK, sourceThreadId: WORK }, pluginMetadata: metadata.get(FORK) as never }),
    );
    expect(forkConfig.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(forkConfig.instructions).toContain("learning_ask");
    // The work thread still gets nothing.
    expect(await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: WORK } }))).toEqual({ tools: [], skills: [], instructions: null });

    const asked = harness.callAgentTool("learning_ask", { type: "prediction", question: "What does `median([])` do?", files: ["calc.py"] }, { threadId: FORK });
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.pendingInteractions).toHaveLength(1);
    const card = harness.pendingInteractions[0]!;
    expect(card).toMatchObject({ threadId: FORK, rendererId: "exercise", payload: { question: "What does `median([])` do?", files: ["calc.py"], ordinal: 1 } });
    // The card saves what the learner typed and gets it back; the answer clears it.
    const question = { sessionId: (card.payload as { sessionId: string }).sessionId, ordinal: 1 };
    await harness.callRpc("saveDraft", { ...question, draft: { answer: "It raises", confidence: 4 } });
    expect(await harness.callRpc("cardDraft", question)).toEqual({ answer: "It raises", confidence: 4, revision: 0 });
    harness.submitInteraction(card.id, { action: "answer", answer: "It raises ValueError", confidence: 4 });
    expect(await asked).toContain('"It raises ValueError"');

    // The same tool with an answer form: its parameters accept one, and the answer comes back by field id.
    const form = { items: [{ kind: "choice", id: "outcome", label: "What happens?", options: [{ value: "raise", label: "It raises" }, { value: "none", label: "None" }] }] };
    const withForm = harness.callAgentTool("learning_ask", { type: "prediction", question: "And `median([1])`?", form }, { threadId: FORK });
    await new Promise((resolve) => setImmediate(resolve));
    const formCard = harness.pendingInteractions.at(-1)!;
    expect(formCard.payload).toMatchObject({ ordinal: 2, form });
    harness.submitInteraction(formCard.id, { action: "answer", answer: "x", confidence: 2, fields: { outcome: "none" } });
    expect(await withForm).toContain('{"outcome":"none"}');
    expect(await harness.callRpc("cardDraft", question)).toBeNull();

    const after = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    expect(after.offer).toBeNull();
    expect(after.started).toMatchObject({ state: "active", threadId: FORK, asked: 2, answered: 2 });
  });

  it("a provider that cannot fork runs the session in the work thread, through the CLI", async () => {
    const { harness, commitTurn } = await setup({ providerCanFork: false });
    await commitTurn();
    const view = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    const started = (await harness.callRpc("answerOffer", { offerId: view.offer!.id, answer: "start" })) as { threadId: string };
    expect(started.threadId).toBe(WORK);
    expect(harness.sdk.callsTo("threads.fork")).toEqual([]);
    const [send] = harness.sdk.callsTo("threads.send") as [{ input: { visibility?: string; text: string }[] }][];
    expect(send![0].input.map((part) => part.visibility ?? "visible")).toEqual(["visible", "agent-only"]);
    expect(send![0].input[1]!.text).toContain("bb learning ask");

    const question = Buffer.from("What does `mean([])` return?\n").toString("base64");
    const asked = await harness.runCli(["ask", "--type", "debug", "--question-base64", question], { threadId: WORK });
    expect(asked).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("End your turn now") });
    expect(harness.pendingInteractions[0]?.payload).toMatchObject({ question: "What does `mean([])` return?", type: "debug" });
  });

  it("bb learning ask takes an answer form, and refuses an invalid one before showing anything", async () => {
    const { harness, commitTurn } = await setup({ providerCanFork: false });
    await commitTurn();
    const view = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    await harness.callRpc("answerOffer", { offerId: view.offer!.id, answer: "start" });
    const question = Buffer.from("Is `mean` safe to call twice?").toString("base64");
    const encode = (form: unknown) => Buffer.from(JSON.stringify(form)).toString("base64");

    const refused = await harness.runCli(["ask", "--type", "prediction", "--question-base64", question, "--form-base64", encode({ items: [{ kind: "scale", id: "s", label: "S", max: 40 }] })], { threadId: WORK });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("answer form was refused");
    expect(harness.pendingInteractions).toHaveLength(0);

    const form = { items: [{ kind: "yes-no", id: "safe", label: "Safe?" }, { kind: "long-text", id: "why", label: "Why?" }] };
    const asked = await harness.runCli(["ask", "--type", "prediction", "--question-base64", question, "--form-base64", encode(form)], { threadId: WORK });
    expect(asked.exitCode).toBe(0);
    const card = harness.pendingInteractions[0]!;
    expect(card.payload).toMatchObject({ form });
    harness.submitInteraction(card.id, { action: "answer", answer: "x", confidence: 3, fields: { safe: true, why: "No state" } });
    await new Promise((resolve) => setImmediate(resolve));
    const sends = harness.sdk.callsTo("threads.send") as [{ input: { text: string }[] }][];
    expect(sends.at(-1)![0].input[1]!.text).toContain('{"safe":true,"why":"No state"}');
  });

  it("a sub-agent thread gets no offer, but a session started there by hand forks it and resumes there", async () => {
    const { harness, threads, commitTurn, metadata } = await setup();
    // A crew thread: a child of the first mate, spawned by another plugin.
    threads.set(WORK, { ...threads.get(WORK)!, parentThreadId: "thr_mate", originPluginId: "firstmate-crew" });
    await commitTurn();
    const view = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    expect(view).toMatchObject({ eligible: false, canStart: true, offer: null });

    const started = (await harness.callRpc("startSession", { threadId: WORK, topic: '"Add median"', trigger: "manual", refs: {} })) as { threadId: string };
    expect(started.threadId).toBe(FORK);
    const [fork] = harness.sdk.callsTo("threads.fork") as [Record<string, unknown>][];
    expect(fork![0]).toMatchObject({ sourceThreadId: WORK });
    const forkConfig = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: FORK, sourceThreadId: WORK }, pluginMetadata: metadata.get(FORK) as never }),
    );
    expect(forkConfig.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    const session = ((await harness.callRpc("threadView", { threadId: WORK })) as ThreadView).started!;
    expect(session).toMatchObject({ sourceThreadId: WORK, threadId: FORK, state: "active" });

    await harness.callRpc("pauseSession", { sessionId: session.id });
    await expect(harness.callRpc("resumeSession", { sessionId: session.id })).resolves.toEqual({ threadId: FORK });
    expect(((await harness.callRpc("threadView", { threadId: WORK })) as ThreadView).started).toMatchObject({ state: "active" });
  });

  it("a learning session's own thread cannot start another session", async () => {
    const { harness, threads } = await setup();
    threads.set(WORK, { ...threads.get(WORK)!, originPluginId: "learning-exercises" });
    expect((await harness.callRpc("threadView", { threadId: WORK })) as ThreadView).toMatchObject({ eligible: false, canStart: false });
    await expect(harness.callRpc("startSession", { threadId: WORK, topic: "x", trigger: "manual", refs: {} })).rejects.toThrow(/learning session's own thread/);
  });

  it("the CLI refuses a thread with no session", async () => {
    const { harness } = await setup();
    const result = await harness.runCli(["feedback", "--verdict", "correct"], { threadId: WORK });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no learning session");
  });

  it("bb learning principles prints the attributed PRINCIPLES.md", async () => {
    const { harness } = await setup();
    const result = await harness.runCli(["principles"], {});
    expect(result.stdout).toContain("Dr. Cat Hicks");
    expect(result.stdout).toContain("# Learning Principles");
  });
});

describe("review pass 1 (wiring)", () => {
  it("finding 7: the last-commit topic reads a feature branch against its default branch", async () => {
    const { harness } = await setup();
    // bb 0.48.1's Git plugin: no `mergeBaseBranch` → `mergeBase: null`; a branch name → the commits ahead.
    harness.sdk.stub("plugins.callRpc", ({ pluginId, input }: { pluginId: string; input: { mergeBaseBranch?: string } }) => {
      if (pluginId === "bb--github-pr-status") return {};
      const mergeBase =
        input.mergeBaseBranch === "main"
          ? { commits: [{ sha: "c1", shortSha: "c1", subject: "Add median" }, { sha: "c2", shortSha: "c2", subject: "Test median" }], files: [] }
          : null;
      return { outcome: "available", workspace: { checkout: { headSha: "c2" }, branch: { currentBranch: "feature", defaultBranch: "main" }, mergeBase } };
    });
    const { choices } = (await harness.callRpc("topicChoices", { threadId: WORK })) as { choices: { id: string; topic: string }[] };
    expect(choices.find((choice) => choice.id === "commit")?.topic).toBe('"Test median"');
  });

  it("finding 10: another plugin cannot change offers or sessions, though it can read them", async () => {
    const { harness } = await setup();
    const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "someone-else" } };
    await expect(harness.callRpc("setThreadOffers", { threadId: WORK, on: false }, asPlugin)).rejects.toThrow("from its own app only");
    await expect(harness.callRpc("startSession", { threadId: WORK, topic: "x", trigger: "manual", refs: {} }, asPlugin)).rejects.toThrow("from its own app only");
    await expect(harness.callRpc("saveDraft", { sessionId: "ses_x", ordinal: 1, draft: { answer: "x" } }, asPlugin)).rejects.toThrow("from its own app only");
    await expect(harness.callRpc("threadView", { threadId: WORK }, asPlugin)).resolves.toMatchObject({ eligible: true });
  });
});
