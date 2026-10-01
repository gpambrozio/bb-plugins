import { describe, expect, it } from "vitest";

import type { Interaction, PromptRecord } from "./ports";
import { commandApproval, planApproval, question, toolApproval } from "./testing/fixtures";
import { describeInteraction, fallbackSpeech, firstWords, lastPrompt, plainText, preview } from "./timeline";

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
