// The actions file: `.bb/actions.json` at the workspace root, parsed and checked.
//
// Strict JSON (no comments, no trailing commas), so other tools read it too. Every problem names
// where it is: a line and column, and for a value that parses but is wrong, its path in the file
// (`actions[2].command`). Server only: the app gets what this returns through the RPCs, and the
// types from `shared/views.ts`, so jsonc-parser stays out of the app bundle.
// The ESM build: the package's `main` is a UMD build whose lazy `require("./impl/format")` bb's
// bundle cannot resolve, so the server would fail to load.
import { findNodeAtLocation, parseTree, type Node, type ParseError, type ParseErrorCode } from "jsonc-parser/lib/esm/main.js";

import type { Action, Problem } from "./views";

export const LIMITS = {
  /** Bytes; a file larger than this is refused before it is parsed. */
  fileBytes: 256 * 1024,
  actions: 100,
  name: 80,
  command: 16 * 1024,
  cwd: 1024,
  description: 300,
} as const;

export type ParsedActionsFile = { ok: true; actions: Action[] } | { ok: false; problem: Problem };

type Segment = string | number;

const SYNTAX_MESSAGES: Partial<Record<ParseErrorCode, string>> = {
  1: "Invalid symbol",
  2: "Invalid number",
  3: "Expected a property name",
  4: "Expected a value",
  5: "Expected a colon",
  6: "Expected a comma",
  7: "Expected a closing brace",
  8: "Expected a closing bracket",
  9: "Unexpected text after the end of the file",
  10: "Comments are not allowed in JSON",
  11: "Unexpected end of comment",
  12: "Unexpected end of string",
  13: "Unexpected end of number",
  14: "Invalid unicode escape",
  15: "Invalid escape character",
  16: "Invalid character in a string",
};

const ACTION_KEYS = new Set(["name", "command", "cwd", "description"]);
const FILE_KEYS = new Set(["$schema", "actions"]);

/** `actions[1].name` from `["actions", 1, "name"]`. */
export function formatPath(segments: readonly Segment[]): string {
  return segments.map((segment, index) => (typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`)).join("");
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

class ValueError extends Error {
  constructor(
    message: string,
    readonly segments: readonly Segment[],
  ) {
    super(message);
  }
}

/**
 * A relative directory inside the workspace, normalised: `./web/` → `web`, `.` → null. Absolute
 * paths, `..` and backslashes are refused so an action cannot start outside its workspace.
 */
export function normaliseCwd(raw: string): { ok: true; cwd: string | null } | { ok: false; reason: string } {
  const value = raw.trim();
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) return { ok: false, reason: "must be relative to the project's root" };
  if (value.includes("\\")) return { ok: false, reason: "must use / between folders" };
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return { ok: false, reason: "must stay inside the project (no ..)" };
  return { ok: true, cwd: parts.length === 0 ? null : parts.join("/") };
}

function requireString(value: unknown, segments: Segment[], limit: number, label: string): string {
  if (typeof value !== "string") throw new ValueError(`${label} must be a string`, segments);
  const trimmed = value.trim();
  if (trimmed === "") throw new ValueError(`${label} must not be empty`, segments);
  if (trimmed.length > limit) throw new ValueError(`${label} is longer than ${limit} characters`, segments);
  return trimmed;
}

function validate(value: unknown): Action[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValueError('The file must be an object with an "actions" list', []);
  const file = value as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (!FILE_KEYS.has(key)) throw new ValueError(`Unknown field "${key}"; the file has only "actions"`, [key]);
  }
  if (!("actions" in file)) throw new ValueError('Missing the "actions" list', []);
  const list = file.actions;
  if (!Array.isArray(list)) throw new ValueError('"actions" must be a list', ["actions"]);
  if (list.length > LIMITS.actions) throw new ValueError(`More than ${LIMITS.actions} actions`, ["actions"]);
  const seen = new Map<string, number>();
  return list.map((entry, index): Action => {
    const at: Segment[] = ["actions", index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new ValueError("Each action must be an object", at);
    const action = entry as Record<string, unknown>;
    for (const key of Object.keys(action)) {
      if (!ACTION_KEYS.has(key)) throw new ValueError(`Unknown field "${key}"; an action has name, command, cwd and description`, [...at, key]);
    }
    if (!("name" in action)) throw new ValueError('Missing "name"', at);
    if (!("command" in action)) throw new ValueError('Missing "command"', at);
    const name = requireString(action.name, [...at, "name"], LIMITS.name, '"name"');
    const key = name.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined) throw new ValueError(`Two actions are named "${name}" (actions[${earlier}] and actions[${index}])`, [...at, "name"]);
    seen.set(key, index);
    const command = requireString(action.command, [...at, "command"], LIMITS.command, '"command"');
    let cwd: string | null = null;
    if ("cwd" in action) {
      const raw = requireString(action.cwd, [...at, "cwd"], LIMITS.cwd, '"cwd"');
      const normalised = normaliseCwd(raw);
      if (!normalised.ok) throw new ValueError(`"cwd" ${normalised.reason}`, [...at, "cwd"]);
      cwd = normalised.cwd;
    }
    const description = "description" in action ? requireString(action.description, [...at, "description"], LIMITS.description, '"description"') : null;
    return { name, command, cwd, description };
  });
}

/** Where a value's problem is: its node, or the closest parent the file has. */
function locate(text: string, root: Node | undefined, segments: readonly Segment[]): { line: number | null; column: number | null } {
  if (root === undefined) return { line: null, column: null };
  for (let length = segments.length; length >= 0; length -= 1) {
    const node = findNodeAtLocation(root, [...segments.slice(0, length)]);
    if (node !== undefined) {
      // A property's value node: point at its key, where a reader looks.
      const target = node.parent?.type === "property" ? node.parent : node;
      return lineAndColumn(text, target.offset);
    }
  }
  return lineAndColumn(text, root.offset);
}

/** Parses the actions file's text. Never throws: a bad file is a problem to show. */
export function parseActionsFile(text: string): ParsedActionsFile {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  const first = errors[0];
  if (first !== undefined) {
    const { line, column } = lineAndColumn(source, first.offset);
    return { ok: false, problem: { message: SYNTAX_MESSAGES[first.error] ?? "Invalid JSON", line, column, path: null } };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    // jsonc-parser accepted what JSON.parse did not; keep the parser's word.
    return { ok: false, problem: { message: error instanceof Error ? error.message : String(error), line: null, column: null, path: null } };
  }
  try {
    return { ok: true, actions: validate(value) };
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    const { line, column } = locate(source, root, error.segments);
    return { ok: false, problem: { message: error.message, line, column, path: error.segments.length === 0 ? null : formatPath(error.segments) } };
  }
}
