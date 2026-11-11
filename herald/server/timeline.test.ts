import { describe, expect, it } from "vitest";

import type { Interaction, PromptRecord, ThreadEventRow } from "./ports";
import { commandApproval, planApproval, question, toolApproval } from "./testing/fixtures";
import { describeInteraction, fallbackSpeech, firstWords, lastPrompt, plainText, preview, turnRequest } from "./timeline";

describe("describeInteraction", () => {
  it("reads a question's prompt and options", () => {
    expect(describeInteraction(question())).toEqual({
      reason: "question",
      headline: "Which DB?",
      detail: "Postgres / SQLite",
    });
    expect(describeInteraction(question({ questions: 2 })).headline).toBe("Which DB? (2 questions)");
  });

  it("names a plan and a command", () => {
    expect(describeInteraction(planApproval("Step one: read the code. Step two: fix it."))).toEqual({
      reason: "plan",
      headline: "Plan ready for your approval",
      detail: "Step one: read the code.",
    });
    expect(describeInteraction(commandApproval("rm -rf build"))).toEqual({
      reason: "permission",
      headline: "Wants to run a command",
      detail: "rm -rf build",
    });
    expect(describeInteraction(commandApproval("npm test", "Run the tests")).headline).toBe("Run the tests");
  });

  it("names a tool by its presentation, or by its name", () => {
    expect(describeInteraction(toolApproval("WebFetch", "Fetch a page", "https://example.com"))).toEqual({
      reason: "permission",
      headline: "Fetch a page",
      detail: "https://example.com",
    });
    expect(describeInteraction(toolApproval("WebFetch")).headline).toBe("Wants to use WebFetch");
  });

  it("treats another plugin's request as a question with its title", () => {
    const fromPlugin: Interaction = {
      createdAt: 1,
      id: "i9",
      origin: { kind: "plugin", pluginId: "other", rendererId: "form" },
      payload: { kind: "plugin", title: "Pick a branch", data: null },
      resolution: null,
      resolvedAt: null,
      status: "pending",
      statusReason: null,
      threadId: "t1",
      turnId: null,
    };
    expect(describeInteraction(fromPlugin)).toEqual({ reason: "question", headline: "Pick a branch", detail: null });
  });
});

describe("lastPrompt", () => {
  const prompt = (createdAt: number, ...parts: PromptRecord["input"]): PromptRecord => ({
    id: `m${createdAt}`,
    createdAt,
    input: parts,
  });

  it("returns the newest prompt's visible text, whatever order the history comes in", () => {
    const history = [
      prompt(3, { type: "text", text: "Also add a test", mentions: [] }),
      prompt(1, { type: "text", text: "Fix the login bug", mentions: [] }),
    ];
    expect(lastPrompt(history)).toBe("Also add a test");
    expect(lastPrompt([...history].reverse())).toBe("Also add a test");
  });

  it("leaves out text only the agent was meant to see, and is null when nothing is left", () => {
    expect(
      lastPrompt([
        prompt(
          1,
          { type: "text", text: "Ship it", mentions: [] },
          { type: "text", text: "context for the agent", mentions: [], visibility: "agent-only" },
        ),
      ]),
    ).toBe("Ship it");
    expect(lastPrompt([prompt(1, { type: "text", text: "  ", mentions: [] })])).toBeNull();
    expect(lastPrompt([])).toBeNull();
  });
});

describe("turnRequest", () => {
  const requested = (seq: number, requestId: string, text: string, extra: Record<string, unknown> = {}): ThreadEventRow => ({
    seq,
    type: "client/turn/requested",
    data: { direction: "outbound", requestId, source: "tell", initiator: "user", input: [{ type: "text", text, mentions: [] }], ...extra },
  });
  const accepted = (seq: number, clientRequestId: string): ThreadEventRow => ({
    seq,
    type: "turn/input/accepted",
    data: { providerThreadId: "pt1", clientRequestId },
  });

  it("is the child's report that started the turn, which the prompt history leaves out", () => {
    const report = "[bb system]\n\n@thread:thr_child completed:\n\nPass 1 found two problems.";
    const rows = [
      accepted(59366, "creq_child"),
      requested(59364, "creq_child", report, { initiator: "system", systemMessageKind: "child-completed" }),
      requested(59300, "creq_typed", "Run a review loop"),
    ];
    expect(turnRequest(rows)).toBe(report);
  });

  it("is what the user typed for a typed turn", () => {
    expect(turnRequest([accepted(12, "creq_b"), requested(11, "creq_b", "Figure out why"), accepted(8, "creq_a"), requested(7, "creq_a", "Older")])).toBe(
      "Figure out why",
    );
  });

  it("names another thread's message as such", () => {
    const rows = [accepted(5, "creq_a"), requested(4, "creq_a", "Done: PR ready", { initiator: "agent", senderThreadId: "thr_crew" })];
    expect(turnRequest(rows)).toBe("[Sent by another agent thread] Done: PR ready");
  });

  it("skips a message queued after the turn took its input in", () => {
    const rows = [requested(20, "creq_queued", "Next task"), accepted(12, "creq_b"), requested(11, "creq_b", "This task")];
    expect(turnRequest(rows)).toBe("This task");
  });

  it("leaves out agent-only text", () => {
    const rows = [
      accepted(2, "creq_a"),
      {
        seq: 1,
        type: "client/turn/requested",
        data: {
          requestId: "creq_a",
          initiator: "user",
          input: [
            { type: "text", text: "Approve the plan", mentions: [] },
            { type: "text", text: "<board-context/>", mentions: [], visibility: "agent-only" },
          ],
        },
      },
    ];
    expect(turnRequest(rows)).toBe("Approve the plan");
  });

  it("is null when the log does not say, so the prompt history is used instead", () => {
    // No accepted input yet, or its request is beyond the page read.
    expect(turnRequest([requested(1, "creq_a", "Hello")])).toBeNull();
    expect(turnRequest([accepted(9, "creq_gone"), requested(8, "creq_other", "Other")])).toBeNull();
    expect(turnRequest([])).toBeNull();
    // A row whose shape bb changed is skipped, not thrown on.
    expect(turnRequest([accepted(3, "creq_a"), { seq: 2, type: "client/turn/requested", data: { requestId: "creq_a" } }])).toBeNull();
    // Only agent-only text: nothing the user could see.
    expect(
      turnRequest([
        accepted(2, "creq_a"),
        { seq: 1, type: "client/turn/requested", data: { requestId: "creq_a", input: [{ type: "text", text: "x", visibility: "agent-only" }] } },
      ]),
    ).toBeNull();
  });
});

describe("plainText and firstWords", () => {
  it("strips markdown a voice would spell out", () => {
    expect(plainText("## Done\n\nI fixed `auth.ts` and **added** a [test](http://x).\n```js\ncode\n```")).toBe(
      "Done I fixed auth.ts and added a test. code block",
    );
  });

  it("cuts at a sentence end or adds an ellipsis", () => {
    expect(firstWords("I fixed the login bug in the auth module. Then I added tests.", 30)).toBe(
      "I fixed the login bug in the auth module.",
    );
    expect(firstWords("one two three four five", 3)).toBe("one two three…");
    expect(firstWords("", 3)).toBe("");
  });
});

describe("preview", () => {
  it("flattens to one line and clips with an ellipsis", () => {
    expect(preview("Fix the **login** bug\nplease")).toBe("Fix the login bug please");
    expect(preview("abcdefghij", 6)).toBe("abcde…");
  });
});

describe("fallbackSpeech", () => {
  it("states each event kind plainly", () => {
    const named = { projectName: "Shop", threadTitle: "Login fix" };
    expect(fallbackSpeech({ ...named, reason: "question", headline: "Which DB?", detail: "A / B" })).toBe(
      "Login fix has a question: Which DB? Options: A / B.",
    );
    expect(
      fallbackSpeech({ projectName: null, threadTitle: null, reason: "finished", headline: "Finished", detail: null }),
    ).toBe("A thread finished.");
    // An untitled thread is named by its project.
    expect(
      fallbackSpeech({ projectName: "Shop", threadTitle: null, reason: "finished", headline: "Finished", detail: "Done." }),
    ).toBe("Shop finished. Done.");
    const bot = { projectName: null, threadTitle: "Bot" };
    expect(fallbackSpeech({ ...bot, reason: "permission", headline: "Run command", detail: "npm test" })).toBe(
      "Bot is asking for permission. Run command Command: npm test.",
    );
    expect(fallbackSpeech({ ...bot, reason: "error", headline: "Out of credits", detail: null })).toBe(
      "Bot stopped with an error. Out of credits",
    );
    expect(fallbackSpeech({ ...bot, reason: "plan", headline: "Plan ready", detail: null })).toBe(
      "Bot has a plan ready for your approval. Plan ready",
    );
  });
});
