/**
 * The part of GitHub's GraphQL schema the Viewed marks use, as introspection on api.github.com gave it
 * (October 2026: `__type(name: …)` for each type below, read only), and a checker the tests' fake `gh`
 * runs on those requests: every field selected exists on its type, arguments and variables have the
 * types GitHub declares, required ones are present, and an input object carries only its own fields.
 * It reads the plain queries this plugin writes (no fragments, directives or aliases), nothing more.
 */

/** A type reference as GraphQL writes it: `String`, `ID!`, `[PullRequestChangedFile]`. */
type TypeRef = string;

interface Field {
  type: TypeRef;
  args?: Record<string, TypeRef>;
}

type SchemaType = { kind: "OBJECT"; fields: Record<string, Field> } | { kind: "INPUT_OBJECT"; fields: Record<string, TypeRef> } | { kind: "SCALAR" } | { kind: "ENUM"; values: string[] };

export const GITHUB_SCHEMA: Record<string, SchemaType> = {
  Query: { kind: "OBJECT", fields: { repository: { type: "Repository", args: { owner: "String!", name: "String!", followRenames: "Boolean" } } } },
  Mutation: {
    kind: "OBJECT",
    fields: {
      markFileAsViewed: { type: "MarkFileAsViewedPayload", args: { input: "MarkFileAsViewedInput!" } },
      unmarkFileAsViewed: { type: "UnmarkFileAsViewedPayload", args: { input: "UnmarkFileAsViewedInput!" } },
    },
  },
  Repository: { kind: "OBJECT", fields: { pullRequest: { type: "PullRequest", args: { number: "Int!" } } } },
  PullRequest: {
    kind: "OBJECT",
    fields: { id: { type: "ID!" }, files: { type: "PullRequestChangedFileConnection", args: { after: "String", before: "String", first: "Int", last: "Int" } } },
  },
  PullRequestChangedFileConnection: {
    kind: "OBJECT",
    fields: {
      edges: { type: "[PullRequestChangedFileEdge]" },
      nodes: { type: "[PullRequestChangedFile]" },
      pageInfo: { type: "PageInfo!" },
      totalCount: { type: "Int!" },
    },
  },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: {
      additions: { type: "Int!" },
      changeType: { type: "PatchStatus!" },
      deletions: { type: "Int!" },
      path: { type: "String!" },
      viewerViewedState: { type: "FileViewedState!" },
    },
  },
  PageInfo: { kind: "OBJECT", fields: { endCursor: { type: "String" }, hasNextPage: { type: "Boolean!" }, hasPreviousPage: { type: "Boolean!" }, startCursor: { type: "String" } } },
  MarkFileAsViewedInput: { kind: "INPUT_OBJECT", fields: { clientMutationId: "String", pullRequestId: "ID!", path: "String!" } },
  UnmarkFileAsViewedInput: { kind: "INPUT_OBJECT", fields: { clientMutationId: "String", pullRequestId: "ID!", path: "String!" } },
  MarkFileAsViewedPayload: { kind: "OBJECT", fields: { clientMutationId: { type: "String" }, pullRequest: { type: "PullRequest" } } },
  UnmarkFileAsViewedPayload: { kind: "OBJECT", fields: { clientMutationId: { type: "String" }, pullRequest: { type: "PullRequest" } } },
  FileViewedState: { kind: "ENUM", values: ["DISMISSED", "VIEWED", "UNVIEWED"] },
  PatchStatus: { kind: "ENUM", values: ["ADDED", "CHANGED", "COPIED", "DELETED", "MODIFIED", "RENAMED"] },
  ID: { kind: "SCALAR" },
  String: { kind: "SCALAR" },
  Int: { kind: "SCALAR" },
  Boolean: { kind: "SCALAR" },
};

/** `[Foo]!` → `Foo`. */
function namedType(ref: TypeRef): string {
  return ref.replace(/[[\]!]/g, "");
}

class Parser {
  private readonly tokens: string[];
  private at = 0;

  constructor(text: string) {
    this.tokens = text.match(/[A-Za-z_][A-Za-z0-9_]*|-?\d+|"(?:[^"\\]|\\.)*"|[{}():$!,[\]]/g) ?? [];
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private next(): string {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new Error("The query ends early.");
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`Expected "${token}", got "${got}".`);
  }

  private skipCommas(): void {
    while (this.peek() === ",") this.at++;
  }

  private typeRef(): TypeRef {
    let ref: string;
    if (this.peek() === "[") {
      this.next();
      ref = `[${this.typeRef()}]`;
      this.expect("]");
    } else ref = this.next();
    if (this.peek() === "!") ref += this.next();
    return ref;
  }

  /** A value: a variable (`{ variable }`), or a literal kept as its text. */
  private value(): { variable: string } | { literal: string } {
    if (this.peek() === "$") {
      this.next();
      return { variable: this.next() };
    }
    if (this.peek() === "{") throw new Error("Object literals are not read; pass an input variable.");
    return { literal: this.next() };
  }

  operation(): { kind: "query" | "mutation"; variables: Record<string, TypeRef>; selection: Selection[] } {
    const kind = this.next();
    if (kind !== "query" && kind !== "mutation") throw new Error(`An operation starts with query or mutation, not "${kind}".`);
    const variables: Record<string, TypeRef> = {};
    if (this.peek() === "(") {
      this.next();
      while (this.peek() !== ")") {
        this.expect("$");
        const name = this.next();
        this.expect(":");
        variables[name] = this.typeRef();
        this.skipCommas();
      }
      this.next();
    }
    const selection = this.selectionSet();
    if (this.peek() !== undefined) throw new Error(`Unexpected "${this.peek()}" after the operation.`);
    return { kind, variables, selection };
  }

  private selectionSet(): Selection[] {
    this.expect("{");
    const fields: Selection[] = [];
    while (this.peek() !== "}") {
      const name = this.next();
      const args: Record<string, { variable: string } | { literal: string }> = {};
      if (this.peek() === "(") {
        this.next();
        while (this.peek() !== ")") {
          const arg = this.next();
          this.expect(":");
          args[arg] = this.value();
          this.skipCommas();
        }
        this.next();
      }
      fields.push({ name, args, selection: this.peek() === "{" ? this.selectionSet() : null });
      this.skipCommas();
    }
    this.next();
    return fields;
  }
}

interface Selection {
  name: string;
  args: Record<string, { variable: string } | { literal: string }>;
  selection: Selection[] | null;
}

/** Whether a variable of type `variable` may be passed where `wanted` is declared (a non-null one also fits a nullable place). */
function fits(variable: TypeRef, wanted: TypeRef): boolean {
  return variable === wanted || variable === `${wanted}!`;
}

function checkSelection(typeName: string, selection: Selection[], variables: Record<string, TypeRef>, path: string, errors: string[]): void {
  const type = GITHUB_SCHEMA[typeName];
  if (type === undefined || type.kind !== "OBJECT") {
    errors.push(`${path}: ${typeName} has no fields (or is not in the recorded schema).`);
    return;
  }
  for (const field of selection) {
    const at = `${path}.${field.name}`;
    const declared = type.fields[field.name];
    if (declared === undefined) {
      errors.push(`${at}: ${typeName} has no field ${field.name}.`);
      continue;
    }
    const args = declared.args ?? {};
    for (const [arg, value] of Object.entries(field.args)) {
      const wanted = args[arg];
      if (wanted === undefined) errors.push(`${at}: no argument ${arg}.`);
      else if ("variable" in value) {
        const given = variables[value.variable];
        if (given === undefined) errors.push(`${at}: $${value.variable} is not declared.`);
        else if (!fits(given, wanted)) errors.push(`${at}: $${value.variable} is ${given}, ${arg} wants ${wanted}.`);
      } else if (namedType(wanted) === "Int" && !/^-?\d+$/.test(value.literal)) errors.push(`${at}: ${arg} wants an Int, got ${value.literal}.`);
    }
    for (const [arg, wanted] of Object.entries(args)) if (wanted.endsWith("!") && field.args[arg] === undefined) errors.push(`${at}: the required argument ${arg} is missing.`);
    const kind = GITHUB_SCHEMA[namedType(declared.type)]?.kind;
    if (kind === "OBJECT") {
      if (field.selection === null) errors.push(`${at}: an object field needs a selection.`);
      else checkSelection(namedType(declared.type), field.selection, variables, at, errors);
    } else if (field.selection !== null) errors.push(`${at}: a ${kind ?? "unknown"} field takes no selection.`);
  }
}

function checkValue(ref: TypeRef, value: unknown, at: string, errors: string[]): void {
  if (value === null || value === undefined) {
    if (ref.endsWith("!")) errors.push(`${at}: required (${ref}).`);
    return;
  }
  const name = namedType(ref);
  const type = GITHUB_SCHEMA[name];
  if (type === undefined) errors.push(`${at}: ${name} is not in the recorded schema.`);
  else if (type.kind === "INPUT_OBJECT") {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${at}: ${name} is an object.`);
      return;
    }
    const given = value as Record<string, unknown>;
    for (const key of Object.keys(given)) if (type.fields[key] === undefined) errors.push(`${at}: ${name} has no field ${key}.`);
    for (const [key, fieldRef] of Object.entries(type.fields)) checkValue(fieldRef, given[key], `${at}.${key}`, errors);
  } else if (type.kind === "ENUM") {
    if (typeof value !== "string" || !type.values.includes(value)) errors.push(`${at}: not a ${name}.`);
  } else if (name === "Int") {
    if (!Number.isInteger(value)) errors.push(`${at}: not an Int.`);
  } else if (name === "Boolean") {
    if (typeof value !== "boolean") errors.push(`${at}: not a Boolean.`);
  } else if (typeof value !== "string") errors.push(`${at}: not a ${name}.`);
}

/** What is wrong with a request against the recorded schema; empty when GitHub would take it. */
export function checkGithubRequest(query: string, variables: Record<string, unknown>): string[] {
  const errors: string[] = [];
  let operation;
  try {
    operation = new Parser(query).operation();
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  checkSelection(operation.kind === "query" ? "Query" : "Mutation", operation.selection, operation.variables, operation.kind, errors);
  for (const name of Object.keys(variables)) if (operation.variables[name] === undefined) errors.push(`$${name} is sent but not declared.`);
  for (const [name, ref] of Object.entries(operation.variables)) checkValue(ref, variables[name], `$${name}`, errors);
  return errors;
}
