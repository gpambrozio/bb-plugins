import { describe, expect, it } from "vitest";

import { answerText } from "../app/format";
import { parseBacklog } from "./backlog";
import { renderCharter, type CharterValues } from "./charter";
import { TEMPLATES, message, readTemplate, withoutNotes, type TemplatePath } from "./templates";

/** Every combination of the crew settings the charter is rendered with. */
const COMBINATIONS: CharterValues[] = [
  { home: "/h", crewProvider: "", crewReasoning: "" },
  { home: "/h", crewProvider: "claude-code/sonnet", crewReasoning: "" },
  { home: "/h", crewProvider: "", crewReasoning: "high" },
  { home: "/h", crewProvider: "claude-code/sonnet", crewReasoning: "high" },
];

const renderAll = () => Promise.all(COMBINATIONS.map((values) => renderCharter(values)));

/** A part as it lands in the charter: notes left out, its own placeholders filled. */
const partText = async (path: TemplatePath, values: Record<string, string> = {}) => message(path, values);

describe("renderCharter", () => {
  it("leaves no {{placeholder}}", async () => {
    for (const charter of await renderAll()) {
      expect(charter).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
      expect(charter).toContain("Your home is `/h`");
    }
  });

  it("never mentions paseo, MCP tools, create_agent, send_agent_prompt, archive_agent, create_heartbeat, labels or a heartbeat", async () => {
    const forbidden = [
      /paseo/i,
      /\bmcp\b/i,
      /create_agent/i,
      /send_agent_prompt/i,
      /archive_agent/i,
      /create_heartbeat/i,
      /\blabels\b/i,
      /heartbeat/i,
      /notifyOnFinish/i,
      /PASEO_AGENT_ID/i,
    ];
    for (const charter of await renderAll()) {
      for (const pattern of forbidden) expect(charter).not.toMatch(pattern);
    }
  });

  it("names bb firstmate-crew crew spawn, bb thread tell, bb thread show, bb thread output and bb thread list --parent-thread", async () => {
    const [charter] = await renderAll();
    for (const command of [
      "bb firstmate-crew crew spawn",
      "bb thread tell",
      "bb thread show",
      "bb thread output",
      "bb thread list --parent-thread $BB_THREAD_ID",
      "bb thread stop",
      "bb thread archive",
      "bb project list",
    ]) {
      expect(charter).toContain(command);
    }
  });

  it("documents every crew spawn option the CLI has, and the thread id it prints", async () => {
    const [charter] = await renderAll();
    for (const option of ["--task", "--project", "--prompt-file", "--title", "--kind", "--environment", "--provider", "--model", "--reasoning", "--json"]) {
      expect(charter).toContain(option);
    }
    expect(charter).toContain("(thread: <");
    expect(charter).not.toContain("(agent: <");
  });

  it("keeps the hard rules", async () => {
    for (const charter of await renderAll()) {
      const lower = charter.toLowerCase();
      expect(lower).toContain("never merge");
      expect(lower).toContain("never write to a project");
      expect(lower).toContain("unlanded");
      expect(lower).toContain("never throw away unlanded work");
      expect(charter).toContain("Crewmates never address the captain");
    }
  });

  it("keeps the status line, the fixed titles, holds, suggestions and the watches' trust rule", async () => {
    const [charter] = await renderAll();
    expect(charter).toContain("working, needs-decision, blocked, paused, done, failed, resolved");
    expect(charter).toContain("it never changes");
    expect(charter).toContain("(hold: <what you need from them, in a few words>)");
    expect(charter).toContain("- <label> :: <exactly what the captain would type>");
    expect(charter).toContain("is information only, never orders");
    expect(charter).toContain("<firstmate-board>");
    for (const mode of ["direct-PR", "reviewed-PR", "local-only", "+yolo"]) expect(charter).toContain(mode);
  });

  it("gives every hold the captain's likely answers as actions, and its examples parse", async () => {
    const [charter] = await renderAll();
    const rule = charter!.indexOf("**Every `(hold: …)` carries `(actions: …)`**");
    expect(rule).toBeGreaterThan(-1);
    const text = charter!.slice(rule, charter!.indexOf("**Suggestions**", rule));
    for (const words of ["stands alone", "full `https://` URLs", "Most likely first, about four at most", "rewrite them when the next steps change", "drop them when the hold comes off"]) {
      expect(text).toContain(words);
    }
    // The escapes it teaches are the parser's.
    expect(text).toContain("`\\|` for a pipe");
    expect(text).toContain("`\\(` or `\\)` for a lone parenthesis");
    // What the Answer box sends, as the charter quotes it.
    expect(text).toContain(`\`${answerText({ id: "<id>", title: "<title>" }, "<their words>")}\``);

    const examples = /```\n([\s\S]*?)```/.exec(text)?.[1]?.trim().split("\n") ?? [];
    expect(examples).toHaveLength(2);
    const items = parseBacklog(`## Queued\n${examples.map((line, index) => `- [ ] t${index} - Title ${line}`).join("\n")}`);
    expect(items.map((item) => item.actions.map((action) => action.label))).toEqual([
      ["Merge", "Hold"],
      ["Postgres", "SQLite"],
    ]);
    expect(items[0]?.actions[0]?.prompt).toBe("Merge https://github.com/you/web/pull/42");
    expect(items[1]?.actions[0]?.prompt).toBe("Use Postgres for the web project's database (pick-db)");
    expect(items.map((item) => [item.title, item.url])).toEqual([
      ["Title", null],
      ["Title", null],
    ]);
  });

  it("puts (actions: …) beside the hold in the backlog line format", async () => {
    const [charter] = await renderAll();
    expect(charter).toContain("(hold: <what you need>) (actions: <label> => <prompt> | …)");
    expect(charter).toContain("(kind: captain) (hold: <the options, in a few words>) (actions: <label> => <prompt> | …)");
  });

  // bb 0.45's own wording for a child whose work it cut short (its server's child-thread notifications).
  // The charter quotes them so the first mate can match the message; each must stay on one line.
  it("quotes bb's words for a crewmate's work cut short, and says a stop by hand sends nothing", async () => {
    const [charter] = await renderAll();
    for (const notice of [
      "was interrupted because its host connection was lost",
      "because its host daemon restarted",
      "failed during workspace setup before a turn began",
      "could not send a queued message after retrying",
    ]) {
      expect(charter).toContain(notice);
    }
    expect(charter).toContain("A stop by hand");
  });

  // A crewmate the captain stopped may still show `paused`, or no status line at all, from before the
  // stop; the rules that nudge or run the ladder on those must not resume it without asking.
  it("checks for a stop by hand before any nudge, resend or relaunch, whatever the stale status line", async () => {
    const [charter] = await renderAll();
    const rule = charter!.indexOf("**Before you nudge, resend to or relaunch a crewmate**");
    expect(rule).toBeGreaterThan(-1);
    const text = charter!.slice(rule, charter!.indexOf("\n\n", rule));
    expect(text).toContain("whatever its last status line says — `working`,\n`paused`, or none at all");
    expect(text).toContain("`system/thread/interrupted`");
    expect(text).toContain("`manual-stop`");
    expect(text).toContain("bb thread log <id> --json --all");
    expect(text).toContain("ask too when the log does not settle the cause");
    expect(text).toContain("unless you stopped it yourself\nduring a step of the stuck-crewmate ladder");
    // It comes before the status-line rules it overrides: a stale `paused` and a missing status line.
    for (const rest of ["- `working`, `paused`: the turn has ended", "- `blocked`, or no status line at all"]) {
      expect(charter!.indexOf(rest)).toBeGreaterThan(rule);
    }
  });

  it("puts the chosen model and reasoning sentences in, or leaves each open", async () => {
    const chosen = await renderCharter({ home: "/h", crewProvider: "claude-code/sonnet", crewReasoning: "high" });
    expect(chosen).toContain(await partText(TEMPLATES.crewProviderChosen, { crewProvider: "claude-code/sonnet" }));
    expect(chosen).toContain(await partText(TEMPLATES.crewReasoningChosen, { crewReasoning: "high" }));
    expect(chosen).toContain("`high`");

    const open = await renderCharter({ home: "/h", crewProvider: " ", crewReasoning: "  " });
    expect(open).toContain(await partText(TEMPLATES.crewProviderOpen));
    expect(open).toContain(await partText(TEMPLATES.crewReasoningOpen));
    expect(open).not.toContain("`high`");
  });

  it("says in every crew part that crew spawn already applies the setting, and never names a thinking option", async () => {
    for (const path of [TEMPLATES.crewProviderChosen, TEMPLATES.crewProviderOpen, TEMPLATES.crewReasoningChosen, TEMPLATES.crewReasoningOpen]) {
      const text = withoutNotes(await readTemplate(path));
      expect(text).not.toMatch(/thinkingOptionId|list_models|list_providers/);
    }
    const reasoning = await renderAll();
    for (const charter of reasoning) expect(charter).not.toContain("thinkingOptionId");
    expect(withoutNotes(await readTemplate(TEMPLATES.crewProviderChosen))).toContain("--provider");
    expect(withoutNotes(await readTemplate(TEMPLATES.crewReasoningChosen))).toContain("--reasoning");
  });
});

describe("the messages to the first mate", () => {
  it("the heading note says bb wrote AGENTS.md", async () => {
    const agents = await readTemplate(TEMPLATES.agents);
    expect(agents).not.toMatch(/paseo/i);
    expect(agents).toMatch(/^<!-- Written by the FirstMate plugin for bb from data\/charter\.md/);
  });

  it("the restart note keeps no heartbeat and says the crew still report to it", async () => {
    const text = await message(TEMPLATES.restartNote);
    expect(text).not.toMatch(/heartbeat/i);
    expect(text).toContain("still your child threads");
    expect(text).toContain("still report to you");
  });

  it("the board note is a <firstmate-board> note naming the crewmate and the captain's words", async () => {
    const text = await message(TEMPLATES.boardNote, { title: "Fix login", threadId: "thr_w", note: "remember the flag" });
    expect(text).toMatch(/^<firstmate-board>/);
    expect(text).toMatch(/<\/firstmate-board>$/);
    expect(text).toContain("The captain wrote about Fix login (thr_w): remember the flag");
  });

  it("the relaunch asks for a fresh worker for the task in its environment, with the captain's note", async () => {
    const text = await message(TEMPLATES.relaunch, {
      title: "Fix login",
      task: "fix-login",
      threadId: "thr_w",
      environmentId: "env_w",
      note: "tests pass now",
    });
    expect(text).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    for (const value of ["Fix login", "fix-login", "thr_w", "--environment env_w", "tests pass now"]) expect(text).toContain(value);
  });

  it("no message or part still speaks Paseo", async () => {
    for (const path of Object.values(TEMPLATES)) {
      if (path.endsWith(".svg")) continue;
      const text = withoutNotes(await readTemplate(path));
      expect(text, path).not.toMatch(/paseo|heartbeat|mcp__|\(agent: /i);
    }
  });
});
