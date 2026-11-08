import { describe, expect, it } from "vitest";

import type { OrientationDepth, OrientationSummary } from "../shared/orientation";
import { buildBuilderBrief, builderStartLine } from "./content";
import { ORIENTATION_METADATA_KEY, OrientationError, OrientationService } from "./orientation";
import { sha256 } from "./orientation-verify";
import { FakePorts, thread } from "./testing/fake-ports";
import { parseShowboat } from "./testing/showboat-grammar";
import { memoryOrientationStore, settingsWith } from "./testing/store";

const SOURCE = "thr_src";
const BUILDER = "thr_spawn1";
const RETRY = "/work/calc/src/retry.ts";
const RETRY_TEXT = "import { sleep } from './sleep';\nexport function retry() {\n  return attempt();\n}\n";

const SUMMARY: OrientationSummary = {
  purpose: "A calculator.",
  languages: ["TypeScript"],
  stages: ["Parse", "Evaluate"],
  keyFiles: [1, 2, 3, 4, 5, 6].map((n) => ({ path: `src/f${n}.ts`, does: "does", why: "why" })),
  concepts: [1, 2, 3].map((n) => ({ name: `c${n}`, definition: "d", where: "w" })),
  gotchas: ["g1", "g2"],
  exercises: [
    { file: "src/f1.ts", read: "the parser", question: "Why?" },
    { file: "src/f2.ts", read: "the evaluator", question: "How?" },
  ],
  sources: ["README.md"],
};

/** A service over a fresh store, reconciled as the plugin does at load, so starts are allowed. */
async function setup() {
  const ports = new FakePorts();
  ports.threads.set(SOURCE, thread({ id: SOURCE }));
  ports.files.set(RETRY, RETRY_TEXT);
  const { orientations } = memoryOrientationStore();
  const service = new OrientationService(ports, orientations, () => settingsWith());
  await service.reconcile();
  return { ports, store: orientations, service };
}

/** A build started and bound to `BUILDER`. */
async function building(depth: OrientationDepth = "walkthrough") {
  const context = await setup();
  const { orientationId } = await context.service.start({ sourceThreadId: SOURCE, depth });
  return { ...context, id: orientationId };
}

describe("starting a build", () => {
  it("spawns one hidden builder with the orientation id on its metadata, a visible line and the brief agent-only", async () => {
    const { ports, store, id } = await building();
    expect(ports.spawned).toHaveLength(1);
    const [spawn] = ports.spawned;
    expect(spawn).toMatchObject({
      projectId: "proj_1",
      environmentId: "env_1",
      providerId: "claude-code",
      title: "Orientation builder: calc",
      hidden: true,
      metadata: { [ORIENTATION_METADATA_KEY]: id },
    });
    expect(ORIENTATION_METADATA_KEY).toBe("orientation");
    expect(spawn!.visible).toBe(builderStartLine("calc", "walkthrough"));
    expect(spawn!.agentOnly).toBe(buildBuilderBrief({ depth: "walkthrough", projectName: "calc" }));
    expect(store.get(id)).toMatchObject({
      status: "building",
      depth: "walkthrough",
      builderThreadId: BUILDER,
      title: "Repo Orientation: calc",
      sourceThreadId: SOURCE,
      environmentId: "env_1",
      hostId: "host_1",
      workspacePath: "/work/calc",
      headSha: "aaa111",
    });
    expect(ports.changes).toBeGreaterThan(0);
  });

  it("refuses a second build for the project while one is live", async () => {
    const { ports, service } = await building();
    ports.threads.set("thr_other", thread({ id: "thr_other" }));
    await expect(service.start({ sourceThreadId: "thr_other", depth: "summary" })).rejects.toThrow("An orientation is already being built for this project.");
    expect(ports.spawned).toHaveLength(1);
  });

  it("leaves the row failed with the message when the spawn fails, and allows a new start", async () => {
    const { ports, store, service } = await setup();
    ports.spawnFails = true;
    let failedId = "";
    const create = store.create.bind(store);
    store.create = (input) => {
      if (failedId === "") failedId = input.id;
      return create(input);
    };
    const failed = service.start({ sourceThreadId: SOURCE, depth: "summary" });
    await expect(failed).rejects.toBeInstanceOf(OrientationError);
    await expect(failed).rejects.toThrow("spawn refused");
    expect(store.get(failedId)).toMatchObject({ status: "failed", builderThreadId: null });
    expect(store.get(failedId)?.error).toContain("spawn refused");
    ports.spawnFails = false;
    const { orientationId } = await service.start({ sourceThreadId: SOURCE, depth: "summary" });
    expect(orientationId).not.toBe(failedId);
    expect(store.get(orientationId)?.status).toBe("building");
  });

  it("refuses a hidden or plugin thread and a thread with no environment", async () => {
    const { ports, service } = await setup();
    ports.threads.set("thr_hidden", thread({ id: "thr_hidden", visibility: "hidden" }));
    ports.threads.set("thr_mine", thread({ id: "thr_mine", originPluginId: "learning-exercises" }));
    ports.threads.set("thr_noenv", thread({ id: "thr_noenv", environmentId: null }));
    for (const sourceThreadId of ["thr_hidden", "thr_mine", "thr_noenv", "thr_gone"]) {
      await expect(service.start({ sourceThreadId, depth: "summary" })).rejects.toBeInstanceOf(OrientationError);
    }
    expect(ports.spawned).toEqual([]);
  });

  it("refuses every start until a reconcile has read this plugin's threads", async () => {
    const ports = new FakePorts();
    ports.threads.set(SOURCE, thread({ id: SOURCE }));
    const { orientations } = memoryOrientationStore();
    const service = new OrientationService(ports, orientations, () => settingsWith());
    expect(service.clean).toBe(false);
    await expect(service.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("Cleaning up an earlier build; try again shortly.");
    ports.pluginThreadsUnreadable = true;
    await service.reconcile();
    expect(service.clean).toBe(false);
    await expect(service.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("Cleaning up an earlier build; try again shortly.");
    expect(ports.spawned).toEqual([]);
    ports.pluginThreadsUnreadable = false;
    await service.reconcile();
    expect(service.clean).toBe(true);
    await service.start({ sourceThreadId: SOURCE, depth: "summary" });
    expect(ports.spawned).toHaveLength(1);
  });

  it("puts the new thread away when the build was cancelled while bb spawned it", async () => {
    const { ports, store, service } = await setup();
    let id = "";
    ports.duringSpawn = async () => {
      id = store.allLive()[0]!.id;
      await service.cancel(id);
    };
    await service.start({ sourceThreadId: SOURCE, depth: "summary" });
    expect(store.get(id)).toMatchObject({ status: "cancelled", builderThreadId: null });
    expect(ports.stopped).toContain(BUILDER);
    expect(ports.archived).toContain(BUILDER);
  });

  it("writes nothing after it was disposed while bb spawned the builder", async () => {
    const { ports, store, service } = await setup();
    ports.duringSpawn = async () => service.dispose();
    await expect(service.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("reloaded");
    expect(store.allLive()[0]).toMatchObject({ status: "starting", builderThreadId: null });
  });
});

describe("who is the builder", () => {
  it("binds an unbound thread only when its metadata names the row and this plugin started it", async () => {
    const { ports, store, service } = await setup();
    let id = "";
    const results: string[] = [];
    ports.duringSpawn = async (threadId) => {
      id = store.allLive()[0]!.id;
      // Matching metadata, another plugin's thread: refused.
      ports.threads.set("thr_impostor", thread({ id: "thr_impostor", originPluginId: "other-plugin" }));
      ports.threadMetadata.set("thr_impostor", { [ORIENTATION_METADATA_KEY]: id });
      await expect(service.chapter("thr_impostor", "Intro")).rejects.toThrow("This thread is not building an orientation.");
      // No metadata: refused.
      await expect(service.chapter(SOURCE, "Intro")).rejects.toThrow("This thread is not building an orientation.");
      // The builder, before `spawn` answered: bound on its first call.
      results.push(await service.chapter(threadId, "Intro"));
    };
    await service.start({ sourceThreadId: SOURCE, depth: "walkthrough" });
    expect(results[0]).toContain("Intro");
    expect(store.get(id)).toMatchObject({ status: "building", builderThreadId: BUILDER });
    expect(store.blocks(id)).toHaveLength(1);
    await expect(service.note("thr_impostor", "hi")).rejects.toThrow("This thread is not building an orientation.");
  });
});

describe("writing blocks", () => {
  it("refuses listings outside the workspace, with a bad range, too long, past the limit, missing or binary", async () => {
    const { ports, service } = await building();
    const listing = (path: string, lines: string) => service.listing(BUILDER, { path, lines, caption: "c" });
    await expect(listing("../x.ts", "1")).rejects.toThrow("That path is outside the workspace.");
    await expect(listing("/etc/passwd", "1")).rejects.toThrow("That path is outside the workspace.");
    await expect(listing("src/retry.ts", "0")).rejects.toThrow("not a line range");
    await expect(listing("src/retry.ts", "1-201")).rejects.toThrow("at most 200");
    await expect(listing("src/retry.ts", "2-9")).rejects.toThrow("`src/retry.ts` has only 4 lines.");
    await expect(listing("src/nope.ts", "1")).rejects.toThrow("src/nope.ts");
    ports.fileReads.set("/work/calc/logo.png", { kind: "binary" });
    await expect(listing("logo.png", "1")).rejects.toThrow("`logo.png` is not a text file.");
    ports.fileReads.set("/work/calc/big.json", { kind: "too-large" });
    await expect(listing("big.json", "1")).rejects.toThrow("`big.json` is larger than 1 MiB.");
    ports.fileReads.set("/work/calc/flaky.ts", null);
    await expect(listing("flaky.ts", "1")).rejects.toThrow("`flaky.ts`");
    for (let n = 0; n < 60; n += 1) await listing("src/retry.ts", "1");
    await expect(listing("src/retry.ts", "1")).rejects.toThrow("60 listings");
  });

  it("captures a listing from the file and returns its text, storing the hash and the build's HEAD", async () => {
    const { ports, store, service, id } = await building();
    const changes = ports.changes;
    const reply = await service.listing(BUILDER, { path: "./src/retry.ts", lines: "2-3", caption: "The retry loop" });
    const captured = "export function retry() {\n  return attempt();";
    expect(reply).toBe(`Listing 1 captured (src/retry.ts:2-3):\n\n\`\`\`\n${captured}\n\`\`\``);
    expect(store.blocks(id)).toEqual([
      expect.objectContaining({ kind: "listing", number: 1, caption: "The retry loop", path: "src/retry.ts", startLine: 2, endLine: 3, text: captured, sha256: sha256(captured), ref: "aaa111" }),
    ]);
    expect(ports.changes).toBeGreaterThan(changes);
  });

  it("refuses a note with a fenced code block, a line starting with an image, or too long, and keeps a good one", async () => {
    const { store, service, id } = await building();
    await expect(service.note(BUILDER, "See:\n```ts\nx\n```")).rejects.toThrow("fenced code block");
    await expect(service.note(BUILDER, "See:\n  ~~~\nx\n~~~")).rejects.toThrow("fenced code block");
    await expect(service.note(BUILDER, "Look:\n![diagram](img.png)\nabove")).rejects.toThrow("image");
    // showboat reads the whole line as an image block and drops the sentence after it.
    await expect(service.note(BUILDER, "![Architecture](docs/architecture.png) The diagram shows the request flow.")).rejects.toThrow("image");
    await expect(service.note(BUILDER, "x".repeat(8_001))).rejects.toThrow("8000");
    await expect(service.note(BUILDER, "  ")).rejects.toThrow(OrientationError);
    await service.note(BUILDER, "Listing 1 shows ![inline](a.png) in a sentence, and `code` is fine.");
    expect(store.blocks(id)).toHaveLength(1);
  });

  it("exports every note it accepts with no image block, as showboat parses the file (review finding 6)", async () => {
    const { ports, store, service, id } = await building();
    await service.chapter(BUILDER, "Retries");
    await service.listing(BUILDER, { path: "src/retry.ts", lines: "2-3", caption: "loop" });
    await service.note(BUILDER, "Listing 1 is the loop.");
    const candidates = [
      "![Architecture](docs/architecture.png) The diagram shows the request flow.",
      "Intro\n![Architecture](docs/architecture.png) The diagram.",
      "![x](y)",
      "Windows lines\r\n![x](y)\r\nmore",
      "The diagram ![Architecture](docs/a.png) shows the flow.",
      "Intro\n  ![indented](a.png) stays commentary",
      "![]() has no target, then ![b](c)",
      "![alt] (not a reference)",
      "!\\[escaped](x.png)",
      "Ends on an image: ![Architecture](docs/a.png)",
    ];
    const accepted: string[] = [];
    for (const note of candidates) {
      try {
        await service.note(BUILDER, note);
        accepted.push(note);
      } catch (error) {
        expect(error).toBeInstanceOf(OrientationError);
      }
    }
    expect(accepted).toEqual(candidates.slice(4));
    await service.summary(BUILDER, SUMMARY);
    await service.finish(BUILDER);
    await service.export(id, { path: "ORIENTATION.md", replace: false });
    const exported = ports.writes[0]!.content;
    for (const note of accepted) expect(exported).toContain(note);
    expect(parseShowboat(exported).filter((block) => block.type === "image")).toEqual([]);
    expect(store.blocks(id).filter((block) => block.kind === "note")).toHaveLength(accepted.length + 1);
  });

  it("refuses chapters, notes and listings in a summary-only build", async () => {
    const { store, service, id } = await building("summary");
    await expect(service.chapter(BUILDER, "Intro")).rejects.toThrow("summary-only");
    await expect(service.note(BUILDER, "Hello")).rejects.toThrow("summary-only");
    await expect(service.listing(BUILDER, { path: "src/retry.ts", lines: "1", caption: "c" })).rejects.toThrow("summary-only");
    expect(store.blocks(id)).toEqual([]);
  });

  it("refuses a chapter title that is empty, too long or more than one line", async () => {
    const { service } = await building();
    await expect(service.chapter(BUILDER, " ")).rejects.toThrow(OrientationError);
    await expect(service.chapter(BUILDER, "x".repeat(121))).rejects.toThrow("120");
    await expect(service.chapter(BUILDER, "a\nb")).rejects.toThrow("one line");
  });

  it("pops the newest block and says what it removed; a popped listing number is not reused", async () => {
    const { store, service, id } = await building();
    await service.chapter(BUILDER, "Intro");
    await service.listing(BUILDER, { path: "src/retry.ts", lines: "1", caption: "c" });
    expect(await service.pop(BUILDER)).toContain("Listing 1");
    expect(await service.pop(BUILDER)).toContain("Intro");
    expect(await service.pop(BUILDER)).toBe("There is nothing to remove.");
    expect(await service.listing(BUILDER, { path: "src/retry.ts", lines: "1", caption: "c" })).toMatch(/^Listing 2 captured/);
    expect(store.blocks(id)).toHaveLength(1);
  });

  it("refuses a summary with zod's reasons, one per line, and saves a good one", async () => {
    const { store, service, id } = await building("summary");
    const refused = service.summary(BUILDER, { ...SUMMARY, keyFiles: [], gotchas: [] });
    await expect(refused).rejects.toBeInstanceOf(OrientationError);
    const message = await refused.catch((error: Error) => error.message);
    expect(message.split("\n").filter((line) => line.startsWith("- "))).toEqual([expect.stringContaining("keyFiles"), expect.stringContaining("gotchas")]);
    expect(store.get(id)?.summary).toBeNull();
    await service.summary(BUILDER, SUMMARY);
    expect(store.get(id)?.summary).toEqual(SUMMARY);
  });
});

describe("finishing", () => {
  it("refuses without a summary", async () => {
    const { store, service, id } = await building("summary");
    await expect(service.finish(BUILDER)).rejects.toThrow("summary");
    expect(store.get(id)?.status).toBe("building");
  });

  it("refuses a walkthrough with no chapter, or with a listing no note mentions, naming it", async () => {
    const { service } = await building();
    await service.summary(BUILDER, SUMMARY);
    await expect(service.finish(BUILDER)).rejects.toThrow("chapter");
    await service.chapter(BUILDER, "Retries");
    await service.listing(BUILDER, { path: "src/retry.ts", lines: "1", caption: "imports" });
    await service.listing(BUILDER, { path: "src/retry.ts", lines: "2-3", caption: "loop" });
    await service.note(BUILDER, "Listing 1 imports sleep; Listing 12 is not a thing.");
    const message = await service.finish(BUILDER).catch((error: Error) => error.message);
    expect(message).toContain("Listing 2");
    expect(message).not.toMatch(/Listing 1\b/);
  });

  it("refuses a note that mentions a listing that does not exist, naming the numbers there are", async () => {
    const { store, service, id } = await building();
    await service.summary(BUILDER, SUMMARY);
    await service.chapter(BUILDER, "Retries");
    await service.listing(BUILDER, { path: "src/retry.ts", lines: "1", caption: "imports" });
    await service.listing(BUILDER, { path: "src/retry.ts", lines: "2-3", caption: "loop" });
    // A pop leaves a gap: Listing 2 is gone, and the next one is 3.
    await service.pop(BUILDER);
    await service.listing(BUILDER, { path: "src/retry.ts", lines: "2-3", caption: "loop again" });
    await service.note(BUILDER, "Listing 1 imports sleep; Listing 2 loops, and Listing 3 too.");
    const message = await service.finish(BUILDER).catch((error: Error) => error.message);
    expect(message).toContain("no Listing 2");
    expect(message).toContain("numbered 1, 3");
    expect(store.get(id)?.status).toBe("building");
    await service.note(BUILDER, "Listing 3 is the loop.");
    // Still refused while the first note names Listing 2.
    await expect(service.finish(BUILDER)).rejects.toThrow("no Listing 2");
  });

  it("marks the orientation ready, replaces the previous one, checks its listings and leaves the builder running", async () => {
    const first = await building("summary");
    await first.service.summary(BUILDER, SUMMARY);
    expect(await first.service.finish(BUILDER)).toBe("The orientation is ready.");
    expect(first.store.get(first.id)).toMatchObject({ status: "ready" });
    // Not stopped from inside its own tool call (R5): it is put away when it goes idle.
    expect(first.ports.stopped).toEqual([]);
    expect(first.ports.archived).toEqual([]);

    const { orientationId: second } = await first.service.start({ sourceThreadId: SOURCE, depth: "walkthrough" });
    const builder2 = "thr_spawn2";
    await first.service.summary(builder2, SUMMARY);
    await first.service.chapter(builder2, "Retries");
    await first.service.listing(builder2, { path: "src/retry.ts", lines: "2-3", caption: "loop" });
    await first.service.note(builder2, "Listing 1 is the loop.");
    expect(await first.service.finish(builder2)).toBe("The orientation is ready.");
    expect(first.store.get(second)).toMatchObject({ status: "ready" });
    expect(first.store.get(first.id)).toBeNull();
    const [, listing] = first.store.blocks(second);
    expect(listing).toMatchObject({ kind: "listing", check: { state: "current", startLine: 2, endLine: 3 } });
    expect(first.ports.stopped).toEqual([]);
    expect(first.ports.archived).toEqual([]);
    await expect(first.service.note(builder2, "more")).rejects.toThrow("This thread is not building an orientation.");
    expect(first.service.view(first.store.get(second)!.projectKey)).toEqual({ current: first.store.get(second), live: null });
  });
});

describe("cancelling and deleting", () => {
  it("cancels a build, stopping and archiving its builder", async () => {
    const { ports, store, service, id } = await building();
    await service.cancel(id);
    expect(store.get(id)).toMatchObject({ status: "cancelled", error: "Cancelled." });
    expect(ports.stopped).toEqual([BUILDER]);
    expect(ports.archived).toEqual([BUILDER]);
    await expect(service.chapter(BUILDER, "Intro")).rejects.toThrow("This thread is not building an orientation.");
  });

  it("does not throw when the builder cannot be archived, but warns and refuses starts until it is", async () => {
    const { ports, store, service, id } = await building();
    ports.archiveFails = true;
    await service.cancel(id);
    expect(store.get(id)?.status).toBe("cancelled");
    expect(ports.warnings.join("\n")).toContain("archive refused");
    expect(service.clean).toBe(false);
  });

  it("refuses to delete a live orientation and deletes a finished one with its blocks", async () => {
    const { store, service, id } = await building("summary");
    expect(() => service.delete(id)).toThrow(OrientationError);
    await service.cancel(id);
    service.delete(id);
    expect(store.get(id)).toBeNull();
    expect(service.document(id)).toBeNull();
  });
});

/** A ready walkthrough with one listing of `src/retry.ts` lines 2–3. */
async function ready() {
  const context = await building();
  await context.service.summary(BUILDER, SUMMARY);
  await context.service.chapter(BUILDER, "Retries");
  await context.service.listing(BUILDER, { path: "src/retry.ts", lines: "2-3", caption: "loop" });
  await context.service.note(BUILDER, "Listing 1 is the loop.");
  await context.service.finish(BUILDER);
  return context;
}

describe("verify", () => {
  it("reports a listing that moved when lines were added above it", async () => {
    const { ports, store, service, id } = await ready();
    ports.files.set(RETRY, `// a header\n${RETRY_TEXT}`);
    expect(await service.verify(id)).toEqual({ checked: 1, drift: ["Listing 1 (`src/retry.ts:2-3`) moved to 3-4"] });
    expect(store.blocks(id)[1]).toMatchObject({ check: { state: "moved", startLine: 3, endLine: 4 } });
  });

  it("reports changed and missing listings", async () => {
    const { ports, service, id } = await ready();
    ports.files.set(RETRY, "export function retry() {\n  return later();\n}\n");
    expect((await service.verify(id)).drift).toEqual(["Listing 1 (`src/retry.ts:2-3`) changed since aaa111"]);
    ports.files.delete(RETRY);
    expect((await service.verify(id)).drift).toEqual(["Listing 1 (`src/retry.ts:2-3`) missing"]);
  });

  it("reads nothing when the last verify was inside the window", async () => {
    const { ports, service, id } = await ready();
    const reads = ports.reads.length;
    ports.advance(1_000);
    expect(await service.verify(id, { ifOlderThanMs: 60_000 })).toEqual({ checked: 0, drift: [] });
    expect(ports.reads).toHaveLength(reads);
    ports.advance(60_001);
    expect((await service.verify(id, { ifOlderThanMs: 60_000 })).checked).toBe(1);
    expect(ports.reads).toHaveLength(reads + 1);
  });

  it("keeps the window when a listed file cannot be read, and calls changed only when a check changed", async () => {
    const { ports, store, service, id } = await ready();
    // A failed read (not a missing file) leaves the listing's state, and its check time, as they were.
    ports.fileReads.set(RETRY, null);
    ports.advance(60_001);
    const reads = ports.reads.length;
    const changes = ports.changes;
    expect(await service.verify(id, { ifOlderThanMs: 60_000 })).toEqual({ checked: 0, drift: [] });
    expect(ports.reads).toHaveLength(reads + 1);
    expect(ports.changes).toBe(changes);
    expect(store.get(id)?.verifiedAt).toBe(ports.now());
    // Inside the window again, though the listing's own check is still old: nothing is read.
    ports.advance(1_000);
    expect(await service.verify(id, { ifOlderThanMs: 60_000 })).toEqual({ checked: 0, drift: [] });
    expect(ports.reads).toHaveLength(reads + 1);
    expect(ports.changes).toBe(changes);
    // A verify that reads the file and finds it as it was changes no state: no changed().
    ports.fileReads.delete(RETRY);
    expect(await service.verify(id)).toEqual({ checked: 1, drift: [] });
    expect(ports.changes).toBe(changes);
    // One that finds it moved does.
    ports.files.set(RETRY, `// a header\n${RETRY_TEXT}`);
    expect((await service.verify(id)).drift).toEqual(["Listing 1 (`src/retry.ts:2-3`) moved to 3-4"]);
    expect(ports.changes).toBe(changes + 1);
  });

  it("reads the project's checkout when the environment is gone, and changes nothing with neither", async () => {
    const { ports, store, service, id } = await ready();
    ports.checkouts.set("proj_1:host_1", "/checkout/calc");
    ports.files.set("/checkout/calc/src/retry.ts", `\n${RETRY_TEXT}`);
    // The environment first, while it has a checkout.
    expect((await service.verify(id)).drift).toEqual([]);
    expect(ports.reads.at(-1)).toBe(RETRY);
    ports.roots.delete("env_1");
    expect((await service.verify(id)).drift).toEqual(["Listing 1 (`src/retry.ts:2-3`) moved to 3-4"]);
    expect(ports.reads.at(-1)).toBe("/checkout/calc/src/retry.ts");
    ports.checkouts.clear();
    const before = store.blocks(id);
    expect(await service.verify(id)).toEqual({ checked: 0, drift: [] });
    expect(store.blocks(id)).toEqual(before);
  });
});

describe("export", () => {
  it("writes a new file, expecting none to exist", async () => {
    const { ports, service, id } = await ready();
    expect(await service.export(id, { path: "ORIENTATION.md", replace: false })).toEqual({ written: "ORIENTATION.md" });
    expect(ports.writes).toHaveLength(1);
    expect(ports.writes[0]).toMatchObject({ path: "ORIENTATION.md", expectedSha256: null });
    expect(ports.writes[0]!.content).toMatch(/^# Repo Orientation: calc\n/);
    expect(ports.writes[0]!.content).toContain("sed -n '2,3p' 'src/retry.ts'");
  });

  it("asks before replacing an existing file, answering its hash, and replaces it with that hash", async () => {
    const { ports, service, id } = await ready();
    ports.files.set("/work/calc/docs/ORIENTATION.md", "old");
    const asked = await service.export(id, { path: "docs/ORIENTATION.md", replace: false });
    expect(asked).toEqual({ exists: true, sha256: FakePorts.sha("old") });
    expect(ports.writes).toEqual([]);
    const sha256 = "sha256" in asked ? asked.sha256 : null;
    expect(await service.export(id, { path: "./docs/ORIENTATION.md", replace: true, expectedSha256: sha256 })).toEqual({ written: "docs/ORIENTATION.md" });
    expect(ports.writes[0]).toMatchObject({ path: "docs/ORIENTATION.md", expectedSha256: FakePorts.sha("old") });
  });

  it("refuses a replace when the file changed while the user was deciding, keeping the edit", async () => {
    const { ports, service, id } = await ready();
    const key = "/work/calc/ORIENTATION.md";
    ports.files.set(key, "old");
    const asked = await service.export(id, { path: "ORIENTATION.md", replace: false });
    expect(asked).toEqual({ exists: true, sha256: FakePorts.sha("old") });
    // Edited between the question and the user's answer.
    ports.files.set(key, "edited meanwhile");
    const sha256 = "sha256" in asked ? asked.sha256 : null;
    await expect(service.export(id, { path: "ORIENTATION.md", replace: true, expectedSha256: sha256 })).rejects.toThrow("ORIENTATION.md changed while you were deciding; export again.");
    expect(ports.files.get(key)).toBe("edited meanwhile");
    expect(ports.writes).toEqual([]);
  });

  it("refuses a replace with no hash when a file is there, and a write that races a new file", async () => {
    const { ports, service, id } = await ready();
    const key = "/work/calc/ORIENTATION.md";
    ports.files.set(key, "old");
    await expect(service.export(id, { path: "ORIENTATION.md", replace: true })).rejects.toThrow("changed while you were deciding");
    expect(ports.files.get(key)).toBe("old");
    ports.files.delete(key);
    ports.afterRead = (read) => {
      if (read === key) ports.files.set(key, "created meanwhile");
    };
    await expect(service.export(id, { path: "ORIENTATION.md", replace: false })).rejects.toThrow("changed while you were deciding");
    expect(ports.files.get(key)).toBe("created meanwhile");
  });

  it("refuses a path outside the workspace and an orientation that is not ready", async () => {
    const { service, id } = await ready();
    await expect(service.export(id, { path: "../ORIENTATION.md", replace: false })).rejects.toThrow("That path is outside the workspace.");
    const building2 = await building();
    await expect(building2.service.export(building2.id, { path: "ORIENTATION.md", replace: false })).rejects.toBeInstanceOf(OrientationError);
  });
});
