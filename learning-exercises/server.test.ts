import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createFakePluginHost, experimental_scanPublicSdkOnly, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import { BRIEF_CORE, ORIENT_TOOL_INVARIANT } from "./server/content";
import { listEvents, type EventListInput, type LogRow } from "./server/testing/event-log";
import { ORIENT_TOOL_NAMES } from "./server/orientation-tools";
import { TOOL_NAMES } from "./server/tools";
import type { OrientationSummary } from "./shared/orientation";
import type { ThreadView } from "./shared/types";

const WORK = "thr_work";
const FORK = "thr_fork";
/** The hidden builder thread and the visible orientation session thread `threads.spawn` makes. */
const BUILDER = "thr_builder";
const SPAWNED = "thr_spawned";

const MEDIAN = "export function median(xs: number[]): number {\n  const sorted = [...xs].sort((a, b) => a - b);\n  return sorted[sorted.length >> 1]!;\n}\n";

const SUMMARY: OrientationSummary = {
  purpose: "A calculator.",
  languages: ["TypeScript"],
  stages: ["Parse", "Evaluate"],
  keyFiles: [1, 2, 3, 4, 5, 6].map((n) => ({ path: `src/f${n}.ts`, does: "does", why: "why" })),
  concepts: [1, 2, 3].map((n) => ({ name: `c${n}`, definition: "d", where: "w" })),
  gotchas: ["g1", "g2"],
  exercises: [
    { file: "src/median.ts", read: "the median", question: "What does it return for an even count?" },
    { file: "src/f2.ts", read: "the evaluator", question: "How?" },
  ],
  sources: ["README.md"],
};

/**
 * The plugin over the fake host, with bb's SDK and its Git and PR Status plugins stubbed: a Claude Code
 * thread in `env_1` whose HEAD moves from `aaa` to `bbb` with one commit.
 */
async function setup(options: { providerCanFork?: boolean; threadListFails?: boolean; builderActiveDuringSpawn?: boolean } = {}) {
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
  stub("environments.get", () => ({ id: "env_1", hostId: "host_1", path: "/work/calc" }));
  const events: LogRow[] = [{ seq: 1, createdAt: 1, turnId: "t1", type: "turn/completed", data: { status: "completed" } }];
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
  // Orientations: a hidden builder and a visible session thread, both spawned; bb resolves a new
  // thread's configuration before `spawn` answers, so the stub asks for it first.
  const builders: string[] = [];
  const configuredAtSpawn = new Map<string, Awaited<ReturnType<typeof harness.resolveAgentConfiguration>>>();
  stub("threads.spawn", async (request: { visibility: "hidden" | "visible"; pluginMetadata: Record<string, unknown> }) => {
    // Each build gets its own builder thread: the first is BUILDER, a rebuild's BUILDER_2 and so on.
    const id = request.visibility === "hidden" ? (builders.length === 0 ? BUILDER : `${BUILDER}_${builders.length + 1}`) : SPAWNED;
    if (request.visibility === "hidden") builders.push(id);
    metadata.set(id, request.pluginMetadata);
    configuredAtSpawn.set(id, await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id }, pluginMetadata: request.pluginMetadata as never })));
    threads.set(id, makeThreadResponse({ id, projectId: "proj_1", providerId: "claude-code", environmentId: "env_1", originPluginId: "learning-exercises", visibility: request.visibility, status: "active" }));
    // bb can report the builder's first turn before `spawn` answers, before the plugin has bound it.
    if (options.builderActiveDuringSpawn === true && id === BUILDER) await harness.emitThreadEvent("thread.active", { thread: threads.get(id)! });
    return threads.get(id);
  });
  stub("threads.stop", ({ threadId }: { threadId: string }) => {
    threads.set(threadId, { ...threads.get(threadId)!, status: "idle" });
    return { ok: true };
  });
  stub("threads.archive", ({ threadId }: { threadId: string }) => {
    threads.set(threadId, { ...threads.get(threadId)!, archivedAt: 1 });
    return { ok: true };
  });
  const listing = { fails: options.threadListFails === true };
  stub("threads.list", () => {
    if (listing.fails) throw new Error("bb is busy");
    return [...threads.values()].filter((thread) => thread.originPluginId === "learning-exercises" && thread.archivedAt === null);
  });
  stub("threads.experimental_listPluginMetadata", ({ threadIds }: { threadIds: string[] }) => ({
    threads: threadIds.map((threadId) => ({ threadId, metadata: metadata.get(threadId) ?? {} })),
  }));
  const files = new Map([["/work/calc/src/median.ts", MEDIAN]]);
  stub("files.read", ({ path }: { path: string }) => {
    const content = files.get(path);
    if (content === undefined) throw Object.assign(new Error("not found"), { code: "not_found" });
    return { content, contentEncoding: "utf8", sizeBytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
  });
  stub("files.write", ({ path, content }: { path: string; content: string }) => {
    files.set(path, content);
    return { outcome: "written" };
  });
  await plugin(bb);
  // The load-time reconcile runs in the background; starts wait for it.
  await new Promise((resolve) => setImmediate(resolve));
  const commitTurn = async () => {
    await harness.emitThreadEvent("thread.active", { thread: { ...threads.get(WORK)!, status: "active" } });
    head = "bbb";
    await harness.emitThreadEvent("thread.idle", { thread: threads.get(WORK)!, lastAssistantText: "Done." });
  };
  /** The agent starts a turn in a thread: bb logs a `turn/started` row in that turn. */
  const startTurn = (turnId: string) => events.push({ seq: events.length + 1, createdAt: events.length + 1, turnId, type: "turn/started", data: {} });
  return { bb, harness, threads, metadata, files, listing, builders, configuredAtSpawn, commitTurn, startTurn };
}

type OrientationRead = {
  current: { id: string; status: string; blocks: number; listings: number } | null;
  live: { id: string; status: string } | null;
  last: { id: string; status: string; error: string | null } | null;
  canStart: boolean;
  cleaning: boolean;
};

/** Builds a walkthrough through the builder's tools, as an agent would, and answers its id. */
async function buildWalkthrough(harness: Awaited<ReturnType<typeof setup>>["harness"]): Promise<string> {
  const { orientationId } = (await harness.callRpc("startOrientation", { threadId: WORK, depth: "walkthrough" })) as { orientationId: string };
  const tool = (name: string, input: Record<string, unknown>) => harness.callAgentTool(name, input, { threadId: BUILDER });
  expect(await tool("orient_chapter", { title: "The median" })).toContain("Chapter added");
  expect(await tool("orient_note", { markdown: "The median sorts a copy first; see Listing 1." })).toContain("Note added");
  expect(await tool("orient_listing", { path: "src/median.ts", lines: "1-3", caption: "Sorting a copy" })).toContain("Listing 1 captured");
  expect(await tool("orient_summary", SUMMARY)).toContain("Summary saved");
  expect(await tool("orient_finish", {})).toBe("The orientation is ready.");
  return orientationId;
}

describe("zero context until a session starts", () => {
  it("ships no skills and contributes no instructions", async () => {
    const { harness } = await setup();
    expect(harness.registrations.instructionProvider).toBeNull();
    // The orient tools are registered but granted to no thread until the builder is configured.
    expect(harness.registrations.agentTools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES, ...ORIENT_TOOL_NAMES].sort());
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

describe("the never-offer list", () => {
  it("offers in a top-level thread a plugin started, and adding the plugin to the list takes the offer away for good", async () => {
    const { harness, threads, commitTurn } = await setup();
    threads.set(WORK, { ...threads.get(WORK)!, originPluginId: "github-board" });
    await commitTurn();
    const view = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    expect(view.eligible).toBe(true);
    expect(view.offer).toMatchObject({ trigger: "commit" });
    await harness.setSettings({ noOfferPlugins: "automations\ngithub-board" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The change's sweep expired it: taking the plugin off the list again does not bring it back.
    await harness.setSettings({ noOfferPlugins: "automations" });
    expect(((await harness.callRpc("threadView", { threadId: WORK })) as ThreadView).offer).toBeNull();
    expect(await harness.callRpc("offerSeen", { offerId: view.offer!.id })).toEqual({ visible: false });
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
    await harness.callRpc("saveDraft", { ...question, draft: { answer: "It raises", confidence: 4 }, writer: "browser-1" });
    expect(await harness.callRpc("cardDraft", question)).toEqual({ draft: { answer: "It raises", confidence: 4 }, token: expect.any(Number), writer: "browser-1" });
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
    expect(await harness.callRpc("cardDraft", question)).toEqual({ draft: null, token: null, writer: null });

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

  it("the feedback passed with the verdict becomes a card in the turn that recorded it, through the tool and through the CLI", async () => {
    const { harness, commitTurn, startTurn } = await setup({ providerCanFork: false });
    await commitTurn();
    const view = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    await harness.callRpc("answerOffer", { offerId: view.offer!.id, answer: "start" });
    const ask = async (question: string) => {
      await harness.runCli(["ask", "--type", "debug", "--question-base64", Buffer.from(question).toString("base64")], { threadId: WORK });
      const card = harness.pendingInteractions.at(-1)!;
      harness.submitInteraction(card.id, { action: "answer", answer: "It raises", confidence: 3 });
      await new Promise((resolve) => setImmediate(resolve));
      return card.payload;
    };
    await ask("What does `mean([])` return?");
    // The answer starts the agent's next turn; its feedback goes with the verdict, through stdin as base64.
    startTurn("turn_2");
    const feedback = "Right that it raises, but it is `ZeroDivisionError`, from `sum([]) / len([])`.\n\n```py\nmean([])\n```";
    const recorded = await harness.runCli(["feedback", "--verdict", "partly", "--feedback-base64", Buffer.from(`${feedback}\n`).toString("base64")], { threadId: WORK });
    expect(recorded).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Recorded your verdict on question 1") });
    const workspace = { threadId: WORK, environmentId: "env_1", rootPath: "/work/calc" };
    expect(await harness.callRpc("feedbackCards", { threadId: WORK })).toEqual({
      cards: [{ sessionId: expect.any(String), ordinal: 1, turnId: "turn_2", verdict: "partly", feedback, workspace }],
    });
    // The next card carries it above the question too.
    expect(await ask("And `mean([1])`?")).toMatchObject({ previous: { ordinal: 1, answered: true, reply: feedback } });

    // The tool takes the same argument; the last answer's feedback, recorded just before finishing, gets its card.
    startTurn("turn_3");
    const tool = harness.registrations.agentTools.find((registered) => registered.name === "learning_feedback")!;
    expect(tool.inputSchema).toMatchObject({ properties: { feedback: { type: "string", maxLength: 8_000 } }, required: ["verdict"] });
    expect(await harness.callAgentTool("learning_feedback", { verdict: "correct", feedback: "Yes: **1.0**." }, { threadId: WORK })).toContain("question 2");
    await harness.runCli(["finish", "--summary", "Mean and empty lists."], { threadId: WORK });
    const cards = ((await harness.callRpc("feedbackCards", { threadId: WORK })) as { cards: { ordinal: number; turnId: string; feedback: string }[] }).cards;
    expect(cards.map(({ ordinal, turnId, feedback: text }) => [ordinal, turnId, text])).toEqual([
      [1, "turn_2", feedback],
      [2, "turn_3", "Yes: **1.0**."],
    ]);
    // A thread with no session has none, and reads nothing from bb for them.
    expect(await harness.callRpc("feedbackCards", { threadId: "thr_other" })).toEqual({ cards: [] });
  });

  it("bb learning feedback refuses feedback that is not base64 or too long", async () => {
    const { harness, commitTurn } = await setup({ providerCanFork: false });
    await commitTurn();
    const view = (await harness.callRpc("threadView", { threadId: WORK })) as ThreadView;
    await harness.callRpc("answerOffer", { offerId: view.offer!.id, answer: "start" });
    const bad = await harness.runCli(["feedback", "--verdict", "correct", "--feedback-base64", "not base64!"], { threadId: WORK });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("--feedback-base64 is not valid base64");
    const long = await harness.runCli(["feedback", "--verdict", "correct", "--feedback-base64", Buffer.from("x".repeat(8_001)).toString("base64")], { threadId: WORK });
    expect(long.exitCode).not.toBe(0);
    expect(long.stderr).toContain("feedback is longer than 8000 bytes");
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
    await expect(harness.callRpc("saveDraft", { sessionId: "ses_x", ordinal: 1, draft: { answer: "x" }, writer: "w" }, asPlugin)).rejects.toThrow("from its own app only");
    await expect(harness.callRpc("threadView", { threadId: WORK }, asPlugin)).resolves.toMatchObject({ eligible: true });
  });
});

describe("orientations", () => {
  const configure = (harness: Awaited<ReturnType<typeof setup>>["harness"], id: string, pluginMetadata: Record<string, unknown> = {}) =>
    harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id }, pluginMetadata: pluginMetadata as never }));
  const names = (config: { tools: { name: string }[] }) => config.tools.map((tool) => tool.name).sort();
  const NONE = { tools: [], skills: [], instructions: null };

  it("grants the orient tools only to the builder bound to a live build, from before spawn answers until it is ready", async () => {
    const { harness, metadata, configuredAtSpawn } = await setup();
    expect(await harness.callRpc("orientation", { threadId: WORK })).toEqual({ current: null, live: null, last: null, canStart: true, cleaning: false });
    const { orientationId } = (await harness.callRpc("startOrientation", { threadId: WORK, depth: "walkthrough" })) as { orientationId: string };
    const [spawn] = harness.sdk.callsTo("threads.spawn") as [Record<string, unknown>][];
    expect(spawn![0]).toMatchObject({ visibility: "hidden", pluginMetadata: { orientation: orientationId }, environment: { type: "reuse", environmentId: "env_1" } });
    // Resolved while the row was `starting` with no builder bound yet.
    expect(names(configuredAtSpawn.get(BUILDER)!)).toEqual([...ORIENT_TOOL_NAMES].sort());

    const builder = await configure(harness, BUILDER, metadata.get(BUILDER));
    expect(names(builder)).toEqual([...ORIENT_TOOL_NAMES].sort());
    expect(builder.instructions).toBe(ORIENT_TOOL_INVARIANT);
    // Another thread naming the same build, an unknown id, and the work thread get nothing.
    expect(await configure(harness, "thr_other", { orientation: orientationId })).toEqual(NONE);
    expect(await configure(harness, "thr_other", { orientation: "ori_made_up" })).toEqual(NONE);
    expect(await configure(harness, WORK)).toEqual(NONE);
    const view = (await harness.callRpc("orientation", { threadId: WORK })) as OrientationRead;
    expect(view).toMatchObject({ current: null, live: { id: orientationId, status: "building" }, canStart: false, cleaning: false });
  });

  it("builds a walkthrough through the tools, puts the builder away, and runs an orientation session in a spawned thread", async () => {
    const { harness, threads, metadata, configuredAtSpawn } = await setup();
    const orientationId = await buildWalkthrough(harness);
    // Ready: the builder's own metadata no longer unlocks anything.
    expect(await configure(harness, BUILDER, metadata.get(BUILDER))).toEqual(NONE);
    // Finish leaves the builder running (it is inside its own tool call); its idle puts it away.
    expect(harness.sdk.callsTo("threads.archive")).toEqual([]);
    await harness.emitThreadEvent("thread.idle", { thread: threads.get(BUILDER)!, lastAssistantText: "Done." });
    expect(harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: BUILDER }]]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);

    const view = (await harness.callRpc("orientation", { threadId: WORK })) as OrientationRead;
    expect(view).toMatchObject({ current: { id: orientationId, status: "ready", blocks: 3, listings: 1 }, live: null, canStart: true, cleaning: false });
    expect(view.current).toMatchObject({ workspace: { threadId: WORK, environmentId: "env_1", rootPath: "/work/calc" }, summary: SUMMARY });
    const document = (await harness.callRpc("orientationDocument", { orientationId })) as { blocks: Record<string, unknown>[] };
    expect(document.blocks.map((block) => block.kind)).toEqual(["chapter", "note", "listing"]);
    expect(document.blocks[2]).toMatchObject({ number: 1, path: "src/median.ts", startLine: 1, endLine: 3, check: { state: "current" } });
    expect(document.blocks[2]).not.toHaveProperty("sha256");

    const started = (await harness.callRpc("startOrientationSession", { threadId: WORK, orientationId })) as { threadId: string };
    expect(started.threadId).toBe(SPAWNED);
    const spawns = harness.sdk.callsTo("threads.spawn") as [Record<string, unknown>][];
    expect(spawns[1]![0]).toMatchObject({ visibility: "visible", title: "Orientation: calc", pluginMetadata: { session: expect.any(String) } });
    // An unbound `spawn` session that is still `starting` gets the session tools, and so does the bound one.
    expect(names(configuredAtSpawn.get(SPAWNED)!)).toEqual([...TOOL_NAMES].sort());
    expect(names(await configure(harness, SPAWNED, metadata.get(SPAWNED)))).toEqual([...TOOL_NAMES].sort());

    const asked = harness.callAgentTool("learning_ask", { type: "prediction", question: "What does `median([2, 1])` return?", files: ["src/median.ts"] }, { threadId: SPAWNED });
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.pendingInteractions).toHaveLength(1);
    expect(harness.pendingInteractions[0]).toMatchObject({ threadId: SPAWNED, rendererId: "exercise", payload: { ordinal: 1 } });
    harness.submitInteraction(harness.pendingInteractions[0]!.id, { action: "answer", answer: "2", confidence: 3 });
    await asked;
  });

  it("a builder's idle gets no offer and one reminder", async () => {
    const { harness, threads } = await setup();
    await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" });
    await harness.emitThreadEvent("thread.active", { thread: threads.get(BUILDER)! });
    await harness.emitThreadEvent("thread.idle", { thread: { ...threads.get(BUILDER)!, status: "idle" }, lastAssistantText: "I looked around." });
    const sends = harness.sdk.callsTo("threads.send") as [{ threadId: string; input: { text: string; visibility?: string }[] }][];
    expect(sends).toHaveLength(1);
    expect(sends[0]![0]).toMatchObject({ threadId: BUILDER, input: [{ text: "Reminder: finish the orientation." }, { visibility: "agent-only" }] });
    expect(((await harness.callRpc("threadView", { threadId: BUILDER })) as ThreadView).offer).toBeNull();
    expect((await harness.callRpc("orientation", { threadId: WORK })) as OrientationRead).toMatchObject({ live: { status: "building" } });
  });

  it("a builder's failed turn fails the build and puts the builder away", async () => {
    const { harness, threads } = await setup();
    await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" });
    await harness.emitThreadEvent("thread.failed", { thread: threads.get(BUILDER)! });
    expect(harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: BUILDER }]]);
    expect((await harness.callRpc("orientation", { threadId: WORK })) as OrientationRead).toMatchObject({ current: null, live: null, canStart: true });
  });

  it("a failed build shows as `last` with its reason, until a new build is live or a newer one is ready", async () => {
    const { harness, threads, builders } = await setup();
    const read = async () => (await harness.callRpc("orientation", { threadId: WORK })) as OrientationRead;
    const { orientationId: failed } = (await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" })) as { orientationId: string };
    await harness.emitThreadEvent("thread.failed", { thread: threads.get(BUILDER)! });
    expect(await read()).toMatchObject({ current: null, live: null, last: { id: failed, status: "failed", error: "The builder's turn failed." } });

    // Rebuild: while it is live, the failure is not shown; once it is ready, it is older than the ready one.
    // (Times are milliseconds; a real build takes minutes, so the failure and the rebuild's end differ.)
    await new Promise((resolve) => setTimeout(resolve, 3));
    const { orientationId: rebuilt } = (await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" })) as { orientationId: string };
    expect(await read()).toMatchObject({ live: { id: rebuilt }, last: null });
    const rebuilder = builders[1]!;
    expect(await harness.callAgentTool("orient_summary", SUMMARY, { threadId: rebuilder })).toContain("Summary saved");
    expect(await harness.callAgentTool("orient_finish", {}, { threadId: rebuilder })).toBe("The orientation is ready.");
    expect(await read()).toMatchObject({ current: { id: rebuilt, status: "ready" }, live: null, last: null });

    // A rebuild cancelled after a ready one shows as `last`, beside the ready one.
    const { orientationId: cancelled } = (await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" })) as { orientationId: string };
    await harness.callRpc("cancelOrientation", { orientationId: cancelled });
    expect(await read()).toMatchObject({ current: { id: rebuilt }, live: null, last: { id: cancelled, status: "cancelled", error: "Cancelled." } });
  });

  it("a builder's turn reported before it is bound opens no overlap window: a commit in the same checkout still gets its offer", async () => {
    const { harness, commitTurn } = await setup({ builderActiveDuringSpawn: true });
    await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" });
    expect((await harness.callRpc("orientation", { threadId: WORK })) as OrientationRead).toMatchObject({ live: { status: "building" } });
    // The overlap check compares clock times: let the builder's turn start strictly before the commit's end.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await commitTurn();
    expect(((await harness.callRpc("threadView", { threadId: WORK })) as ThreadView).offer).toMatchObject({ trigger: "commit" });
  });

  it("starts stay refused while the load-time clean-up cannot read bb, until the 5-minute sweep can", async () => {
    const { harness, listing } = await setup({ threadListFails: true });
    expect(await harness.callRpc("orientation", { threadId: WORK })).toEqual({ current: null, live: null, last: null, canStart: false, cleaning: true });
    // A refusal, not a plugin crash.
    await expect(harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Cleaning up") });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(harness.registrations.schedules.find((schedule) => schedule.name === "orientation-sweep")).toMatchObject({ cron: "*/5 * * * *" });
    listing.fails = false;
    await harness.runSchedule("orientation-sweep");
    expect(await harness.callRpc("orientation", { threadId: WORK })).toMatchObject({ canStart: true, cleaning: false });
  });

  it("exports a ready orientation, asks before replacing, and refuses another plugin", async () => {
    const { harness, files } = await setup();
    const orientationId = await buildWalkthrough(harness);
    const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "someone-else" } };
    await expect(harness.callRpc("exportOrientation", { orientationId, path: "ORIENTATION.md", replace: false }, asPlugin)).rejects.toThrow("from its own app only");
    await expect(harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" }, asPlugin)).rejects.toThrow("from its own app only");
    await expect(harness.callRpc("deleteOrientation", { orientationId }, asPlugin)).rejects.toThrow("from its own app only");
    expect(files.has("/work/calc/ORIENTATION.md")).toBe(false);

    expect(await harness.callRpc("exportOrientation", { orientationId, path: "ORIENTATION.md", replace: false })).toEqual({ written: "ORIENTATION.md" });
    expect(files.get("/work/calc/ORIENTATION.md")).toContain("# Repo Orientation: calc");
    const asked = (await harness.callRpc("exportOrientation", { orientationId, path: "ORIENTATION.md", replace: false })) as { exists: true; sha256: string };
    expect(asked).toEqual({ exists: true, sha256: expect.any(String) });
    expect(await harness.callRpc("exportOrientation", { orientationId, path: "ORIENTATION.md", replace: true, expectedSha256: asked.sha256 })).toEqual({ written: "ORIENTATION.md" });
    await expect(harness.callRpc("exportOrientation", { orientationId, path: "../x.md", replace: false })).rejects.toMatchObject({ code: "conflict" });
  });

  it("verifies, refuses deleting a live build, and deletes a ready one", async () => {
    const { harness, files } = await setup();
    const orientationId = await buildWalkthrough(harness);
    files.set("/work/calc/src/median.ts", `// moved down\n${MEDIAN}`);
    expect(await harness.callRpc("verifyOrientation", { orientationId })).toEqual({ checked: 1, drift: ["Listing 1 (`src/median.ts:1-3`) moved to 2-4"] });
    const { orientationId: rebuild } = (await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" })) as { orientationId: string };
    await expect(harness.callRpc("deleteOrientation", { orientationId: rebuild })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("cancel it first") });
    await harness.callRpc("cancelOrientation", { orientationId: rebuild });
    await harness.callRpc("deleteOrientation", { orientationId });
    expect((await harness.callRpc("orientation", { threadId: WORK })) as OrientationRead).toMatchObject({ current: null, live: null });
  });

  it("an orientation session starts only from a ready orientation of the thread's project, and not through startSession", async () => {
    const { harness } = await setup();
    const { orientationId } = (await harness.callRpc("startOrientation", { threadId: WORK, depth: "summary" })) as { orientationId: string };
    await expect(harness.callRpc("startOrientationSession", { threadId: WORK, orientationId })).rejects.toMatchObject({ code: "conflict" });
    await expect(harness.callRpc("startSession", { threadId: WORK, topic: "x", trigger: "orientation", refs: {} })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
