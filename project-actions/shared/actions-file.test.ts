import { describe, expect, it } from "vitest";

import { formatPath, normaliseCwd, parseActionsFile } from "./actions-file";
import { describeLocation } from "./views";

const file = (actions: unknown) => JSON.stringify({ actions }, null, 2);

describe("parseActionsFile", () => {
  it("reads actions with their optional fields", () => {
    const parsed = parseActionsFile(
      file([
        { name: "Dev server", command: "npm run dev", description: "Vite on port 5173" },
        { name: "Storybook", command: "npm run storybook", cwd: "./packages/ui/" },
      ]),
    );
    expect(parsed).toEqual({
      ok: true,
      actions: [
        { name: "Dev server", command: "npm run dev", cwd: null, description: "Vite on port 5173" },
        { name: "Storybook", command: "npm run storybook", cwd: "packages/ui", description: null },
      ],
    });
  });

  it("accepts an empty list, a $schema and a byte order mark", () => {
    expect(parseActionsFile('\uFEFF{ "$schema": "x", "actions": [] }')).toEqual({ ok: true, actions: [] });
  });

  it("trims names and commands", () => {
    const parsed = parseActionsFile(file([{ name: "  Test  ", command: "  npm test\n" }]));
    expect(parsed).toEqual({ ok: true, actions: [{ name: "Test", command: "npm test", cwd: null, description: null }] });
  });

  it("gives a syntax error's line and column", () => {
    const parsed = parseActionsFile('{\n  "actions": [\n    { "name": "a" "command": "b" }\n  ]\n}');
    expect(parsed).toEqual({ ok: false, problem: { message: "Expected a comma", line: 3, column: 19, path: null } });
  });

  it("refuses comments and trailing commas, which other JSON readers refuse", () => {
    expect(parseActionsFile('{ "actions": [] // none\n}')).toMatchObject({ ok: false, problem: { message: "Comments are not allowed in JSON", line: 1 } });
    expect(parseActionsFile('{ "actions": [], }')).toMatchObject({ ok: false, problem: { line: 1 } });
  });

  it("refuses an empty file", () => {
    expect(parseActionsFile("")).toMatchObject({ ok: false, problem: { message: "Expected a value" } });
  });

  it("points a wrong value at its key", () => {
    const text = '{\n  "actions": [\n    { "name": "Dev", "command": "npm run dev" },\n    { "name": "Test", "command": 42 }\n  ]\n}';
    expect(parseActionsFile(text)).toEqual({
      ok: false,
      problem: { message: '"command" must be a string', line: 4, column: 23, path: "actions[1].command" },
    });
  });

  it("points a missing field at its action", () => {
    const text = '{\n  "actions": [\n    { "name": "Dev" }\n  ]\n}';
    expect(parseActionsFile(text)).toEqual({ ok: false, problem: { message: 'Missing "command"', line: 3, column: 5, path: "actions[0]" } });
  });

  it.each([
    ["not an object", "[]", "The file must be an object with an \"actions\" list", null],
    ["no actions", "{}", 'Missing the "actions" list', null],
    ["actions not a list", '{ "actions": {} }', '"actions" must be a list', "actions"],
    ["an unknown top-level field", '{ "actions": [], "tasks": [] }', 'Unknown field "tasks"; the file has only "actions"', "tasks"],
    ["an action that is not an object", '{ "actions": ["npm test"] }', "Each action must be an object", "actions[0]"],
    ["a misspelt field", file([{ name: "a", comand: "b" }]), 'Unknown field "comand"; an action has name, command, cwd and description', "actions[0].comand"],
    ["an empty name", file([{ name: " ", command: "b" }]), '"name" must not be empty', "actions[0].name"],
    ["an empty command", file([{ name: "a", command: "" }]), '"command" must not be empty', "actions[0].command"],
    ["a long name", file([{ name: "x".repeat(81), command: "b" }]), '"name" is longer than 80 characters', "actions[0].name"],
    ["a description that is not text", file([{ name: "a", command: "b", description: 1 }]), '"description" must be a string', "actions[0].description"],
    ["an absolute cwd", file([{ name: "a", command: "b", cwd: "/tmp" }]), "\"cwd\" must be relative to the project's root", "actions[0].cwd"],
    ["a cwd that leaves the project", file([{ name: "a", command: "b", cwd: "web/../../x" }]), '"cwd" must stay inside the project (no ..)', "actions[0].cwd"],
  ])("refuses %s", (_label, text, message, path) => {
    expect(parseActionsFile(text)).toMatchObject({ ok: false, problem: { message, path } });
  });

  it("refuses two actions with one name, whatever their case", () => {
    const parsed = parseActionsFile(file([{ name: "Test", command: "a" }, { name: "test", command: "b" }]));
    expect(parsed).toMatchObject({ ok: false, problem: { message: 'Two actions are named "test" (actions[0] and actions[1])', path: "actions[1].name" } });
  });

  it("refuses more than 100 actions", () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ name: `a${index}`, command: "true" }));
    expect(parseActionsFile(file(many))).toMatchObject({ ok: false, problem: { message: "More than 100 actions", path: "actions" } });
  });
});

describe("normaliseCwd", () => {
  it.each([
    [".", null],
    ["./", null],
    ["web", "web"],
    ["./web//app/", "web/app"],
    ["a/./b", "a/b"],
  ])("%s → %s", (raw, cwd) => {
    expect(normaliseCwd(raw)).toEqual({ ok: true, cwd });
  });

  it.each(["/abs", "~/x", "C:/x", "..", "a/../..", "a\\b"])("refuses %s", (raw) => {
    expect(normaliseCwd(raw).ok).toBe(false);
  });
});

describe("where a problem is", () => {
  it("formats paths", () => {
    expect(formatPath(["actions", 2, "command"])).toBe("actions[2].command");
  });

  it("names the file, line, column and path", () => {
    expect(describeLocation({ message: "x", line: 4, column: 7, path: "actions[1].command" })).toBe(".bb/actions.json, line 4, column 7 (actions[1].command)");
    expect(describeLocation({ message: "x", line: 2, column: 1, path: null })).toBe(".bb/actions.json, line 2, column 1");
    expect(describeLocation({ message: "x", line: null, column: null, path: null })).toBe(".bb/actions.json");
  });
});

describe("the parser's import", () => {
  it("is jsonc-parser's ESM build, which bb's server bundle can load", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./actions-file.ts", import.meta.url), "utf8");
    expect(source).toMatch(/from "jsonc-parser\/lib\/esm\/main\.js";/);
    expect(source).not.toMatch(/from "jsonc-parser";/);
  });
});
