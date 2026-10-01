import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SUMMARY_PROMPT } from "../shared/herald";
import { HelperOutcomes, type HelperOutcome } from "./helpers";
import type { HelperPort, HelperSpawn } from "./ports";
import { HELPER_TITLE, buildPrompt, parseSummaryText, renderPrompt, summarize, type SummarizerDeps, type SummaryRequest } from "./summarize";
import { recordingLog } from "./testing/fixtures";

const request: SummaryRequest = {
  thread: { id: "t1", title: "Login fix", projectName: "Shop", folder: "repo" },
  eventId: "t1:idle:1",
  reason: "finished",
  headline: "Finished",
  detail: "I fixed it.",
  output: "I fixed **auth.ts**. ".repeat(3),
  lastUser: "Fix the login bug",
};

describe("buildPrompt", () => {
  it("names the thread, the event, and what was said", () => {
    const prompt = buildPrompt(request);
    expect(prompt).toContain('Thread: "Login fix", in the project "Shop" (folder repo).');
    expect(prompt).toContain("Event: The agent finished its turn");
    expect(prompt).toContain("Detail: I fixed it.");
    expect(prompt).toContain("What the user last asked for: Fix the login bug");
    expect(prompt).toContain("What the agent said: I fixed **auth.ts**.");
    expect(prompt).toContain("Start with the thread's name");
  });

  it("clips a long final message and skips empty sections", () => {
    const prompt = buildPrompt({
      ...request,
      output: "x".repeat(7000),
      lastUser: null,
      detail: null,
      thread: { ...request.thread, title: null, projectName: null },
    });
    expect(prompt).toContain("[…truncated]");
    expect(prompt).not.toContain("What the user last asked for");
    expect(prompt).not.toContain("Detail:");
    expect(prompt).toContain('Thread: "repo", in the project "repo"');
    // An untitled thread takes the project's name as its name.
    expect(buildPrompt({ ...request, thread: { ...request.thread, title: null } })).toContain('Thread: "Shop"');
    // With no folder either, the line naming it is left out whole.
    expect(
      buildPrompt({ ...request, thread: { id: "t1", title: null, projectName: null, folder: null } }),
    ).not.toContain("Thread:");
  });

  it("renders the user's template, and reads a blank one as the default", () => {
    const prompt = buildPrompt(request, "Tell me about {{thread}} in German.\nEvent: {{event}}");
    expect(prompt).toBe(
      "Tell me about Login fix in German.\nEvent: The agent finished its turn and is waiting for the user.",
    );
    expect(buildPrompt(request, "   ")).toBe(buildPrompt(request));
    expect(buildPrompt(request, DEFAULT_SUMMARY_PROMPT)).toBe(buildPrompt(request));
  });
});

describe("renderPrompt", () => {
  const values = { thread: "Login fix", detail: "", output: "It is done." };

  it("drops a whole line whose placeholder is empty for this event", () => {
    expect(renderPrompt("Thread: {{thread}}\nDetail: {{detail}}\nSaid: {{output}}", values)).toBe(
      "Thread: Login fix\nSaid: It is done.",
    );
  });

  it("collapses the blank lines a dropped line leaves behind", () => {
    expect(renderPrompt("A\n\n{{detail}}\n\nB", values)).toBe("A\n\nB");
  });

  it("leaves a name it does not know exactly as typed", () => {
    expect(renderPrompt("Say {{thread}} and {{nonsense}}.", values)).toBe("Say Login fix and {{nonsense}}.");
  });

  it("accepts spaces inside the braces", () => {
    expect(renderPrompt("{{ thread }}", values)).toBe("Login fix");
  });
});

describe("parseSummaryText", () => {
  it("reads the structured output and strips markdown", () => {
    expect(parseSummaryText('{"speech":"Login fix is **done**."}')).toBe("Login fix is done.");
  });

  it("finds JSON inside prose or fences, and falls back to the prose itself", () => {
    expect(parseSummaryText('```json\n{"speech": "Hello there."}\n```')).toBe("Hello there.");
    // Seen from a live helper: the object fenced and under a key of the model's own choosing.
    expect(parseSummaryText('```json\n{\n  "spoken": "Herald test finished. No changes needed."\n}\n```')).toBe(
      "Herald test finished. No changes needed.",
    );
    expect(parseSummaryText('Here you go:\n{"speech": "Done.", "note": "x"}')).toBe("Done.");
    expect(parseSummaryText("```\nJust prose in a fence.\n```")).toBe("Just prose in a fence.");
    expect(parseSummaryText("Login fix finished the work. Nothing is left.")).toBe("Login fix finished the work.");
    expect(() => parseSummaryText("   ")).toThrow("returned nothing");
    expect(() => parseSummaryText(null)).toThrow("returned nothing");
  });
});

interface FakeHelpers extends HelperPort {
  spawned: HelperSpawn[];
  calls: string[];
}

function fakeHelpers(options: { failStop?: boolean; failDelete?: boolean } = {}): FakeHelpers {
  const spawned: HelperSpawn[] = [];
  const calls: string[] = [];
  return {
    spawned,
    calls,
    async spawn(args) {
      spawned.push(args);
      return "h1";
    },
    async stop(id) {
      calls.push(`stop:${id}`);
      if (options.failStop === true) throw new Error("host gone");
    },
    async archive(id) {
      calls.push(`archive:${id}`);
    },
    async delete(id) {
      calls.push(`delete:${id}`);
      if (options.failDelete === true) throw new Error("refused");
    },
  };
}

function deps(helpers: HelperPort, outcome: HelperOutcome | Error, overrides: Partial<SummarizerDeps> = {}): SummarizerDeps {
  return {
    helpers,
    waitForOutcome: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    forgetHelper: vi.fn(),
    providerId: "claude-code",
    model: "claude-haiku-4-5-20251001",
    reasoningLevel: "low",
    timeoutMs: 1000,
    deleteHelper: true,
    log: recordingLog(),
    ...overrides,
  };
}

describe("summarize", () => {
  it("spawns a titled helper with the rendered prompt and returns its sentence", async () => {
    const helpers = fakeHelpers();
    const options = deps(helpers, { kind: "idle", text: '{"speech":"Login fix is done."}' }, { prompt: "Summarise {{thread}}." });
    const summary = await summarize(request, options).result;
    expect(summary).toEqual({ text: "Login fix is done.", model: "claude-code/claude-haiku-4-5-20251001" });
    expect(helpers.spawned).toEqual([
      {
        title: HELPER_TITLE,
        prompt: "Summarise Login fix.",
        providerId: "claude-code",
        model: "claude-haiku-4-5-20251001",
        reasoningLevel: "low",
        metadata: { role: "summarizer", threadId: "t1", eventId: "t1:idle:1" },
      },
    ]);
    expect(options.waitForOutcome).toHaveBeenCalledWith("h1", 1000);
  });

  it("finishes only once the helper is stopped and deleted, though the sentence comes first", async () => {
    let stopped: () => void = () => {};
    const helpers = fakeHelpers();
    helpers.stop = async (id) => {
      helpers.calls.push(`stop:${id}`);
      await new Promise<void>((resolve) => (stopped = resolve));
    };
    const run = summarize(request, deps(helpers, { kind: "idle", text: '{"speech":"Done."}' }));
    await expect(run.result).resolves.toMatchObject({ text: "Done." });
    let finished = false;
    void run.finished.then(() => (finished = true));
    await vi.waitFor(() => expect(helpers.calls).toEqual(["stop:h1"]));
    expect(finished).toBe(false);
    stopped();
    await run.finished;
    expect(helpers.calls).toEqual(["stop:h1", "delete:h1"]);
  });

  it("stops a helper whose spawn answered only after unload", async () => {
    let spawned: (id: string) => void = () => {};
    const helpers = fakeHelpers();
    helpers.spawn = () => new Promise<string>((resolve) => (spawned = resolve));
    const outcomes = new HelperOutcomes();
    const run = summarize(request, deps(helpers, new Error("unused"), { waitForOutcome: (id, ms) => outcomes.wait(id, ms) }));
    // Unload while the spawn is still in flight, then the spawn answers.
    outcomes.cancelAll("Herald was reloaded");
    spawned("h1");
    await expect(run.result).rejects.toThrow("Herald was reloaded");
    await run.finished;
    expect(helpers.calls).toEqual(["stop:h1", "delete:h1"]);
  });

  it("stops the helper and then deletes it, whatever happened", async () => {
    const helpers = fakeHelpers();
    const options = deps(helpers, { kind: "idle", text: '{"speech":"Done."}' });
    await summarize(request, options).result;
    // Fire-and-forget: the sentence does not wait on the clean-up.
    await vi.waitFor(() => expect(helpers.calls).toEqual(["stop:h1", "delete:h1"]));
    expect(options.forgetHelper).toHaveBeenCalledWith("h1");
  });

  it("archives instead when the user keeps helpers", async () => {
    const helpers = fakeHelpers();
    await summarize(request, deps(helpers, { kind: "idle", text: "Done." }, { deleteHelper: false })).result;
    await vi.waitFor(() => expect(helpers.calls).toEqual(["stop:h1", "archive:h1"]));
  });

  it("fails a helper that asked for a tool, and still stops and deletes it", async () => {
    const helpers = fakeHelpers();
    await expect(summarize(request, deps(helpers, { kind: "interaction" })).result).rejects.toThrow("tried to use a tool");
    await vi.waitFor(() => expect(helpers.calls).toEqual(["stop:h1", "delete:h1"]));
  });

  it("reports a failed or timed-out helper and still puts it away", async () => {
    const failed = fakeHelpers();
    await expect(summarize(request, deps(failed, { kind: "failed", error: "rate limited" })).result).rejects.toThrow("rate limited");
    await vi.waitFor(() => expect(failed.calls).toEqual(["stop:h1", "delete:h1"]));

    const slow = fakeHelpers();
    await expect(summarize(request, deps(slow, new Error("did not finish within 1 seconds"))).result).rejects.toThrow("did not finish");
    await vi.waitFor(() => expect(slow.calls).toEqual(["stop:h1", "delete:h1"]));
  });

  it("logs a clean-up that fails rather than throwing it", async () => {
    const helpers = fakeHelpers({ failStop: true, failDelete: true });
    const options = deps(helpers, { kind: "idle", text: "Done." });
    await expect(summarize(request, options).result).resolves.toMatchObject({ text: "Done." });
    const log = options.log as ReturnType<typeof recordingLog>;
    await vi.waitFor(() =>
      expect(log.lines).toEqual([
        "warn: Could not stop summary helper h1: host gone",
        "warn: Could not delete summary helper h1: refused",
      ]),
    );
    expect(options.forgetHelper).toHaveBeenCalledWith("h1");
  });
});
