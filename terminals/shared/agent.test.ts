import { describe, expect, it } from "vitest";

import { DEFAULT_INSTRUCTIONS, FAILURE_PROMPT, agentInstructions, normalizeInstructions } from "./agent";

const SOURCE = { tabLabel: "build", hostName: "Mac mini" };

describe("agentInstructions", () => {
  it("starts with the fixed line naming the tab and machine, then the built-in text", () => {
    const text = agentInstructions(SOURCE);
    expect(text.startsWith('This chat is attached to the user\'s terminal tab "build" on the machine "Mac mini": `terminal_read` and `terminal_run` act on that tab.\n\n')).toBe(true);
    expect(text).toContain("The user is working in a terminal and wants your help with it.");
    expect(text).toContain(
      "When the user asks you to run something, run it in that terminal with `terminal_run`, not in your own shell or with any other tool, and do not ask them to confirm first: their asking is the confirmation.",
    );
    expect(text.endsWith(DEFAULT_INSTRUCTIONS)).toBe(true);
  });

  it("puts the owner's text after the fixed line, filling {{tab}} and {{machine}} with quoted names", () => {
    const text = agentInstructions({ tabLabel: 'my "tab"', hostName: "Studio" }, "  Be brief. You help in {{tab}} on {{machine}}; {{other}} stays.  ");
    expect(text).toBe(
      'This chat is attached to the user\'s terminal tab "my \\"tab\\"" on the machine "Studio": `terminal_read` and `terminal_run` act on that tab.\n\nBe brief. You help in "my \\"tab\\"" on "Studio"; {{other}} stays.',
    );
  });

  it("still names the tab when the owner's text has no placeholders, and uses the built-in text for a blank one", () => {
    expect(agentInstructions(SOURCE, "Answer in French.")).toContain('terminal tab "build" on the machine "Mac mini"');
    expect(agentInstructions(SOURCE, "   ")).toBe(agentInstructions(SOURCE));
  });
});

describe("normalizeInstructions", () => {
  it("stores nothing for none, a blank text or the built-in text, and the trimmed text otherwise", () => {
    expect(normalizeInstructions(null)).toBeNull();
    expect(normalizeInstructions(" \n ")).toBeNull();
    expect(normalizeInstructions(`${DEFAULT_INSTRUCTIONS}\n`)).toBeNull();
    expect(normalizeInstructions(`${DEFAULT_INSTRUCTIONS}\n\nAnswer in French.\n`)).toBe(`${DEFAULT_INSTRUCTIONS}\n\nAnswer in French.`);
  });
});

describe("FAILURE_PROMPT", () => {
  it("is one line that quotes nothing from the terminal", () => {
    expect(FAILURE_PROMPT).toBe("The last command I ran returned an error. Help me debug.");
  });
});
