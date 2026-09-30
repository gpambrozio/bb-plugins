/**
 * `gh api graphql` as a `GitHubApi.graphql`: the GitHub CLI's own login, on
 * whichever machine this module runs on. `gh` exits non-zero on any GraphQL
 * error, which is the behaviour `server/github.ts` relies on.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GraphQLVariables } from "./github";

const execFileAsync = promisify(execFile);

/** gh search caps out well under this; the ceiling only guards a runaway page. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The argument list for one GraphQL request. `-f` sends a string as is and
 * `-F` parses a typed value, so integers go with `-F` and every string with
 * `-f` — a string sent with `-F` that happened to read `true` or `42` would
 * arrive as a boolean or a number. `gh` spells a list variable as a repeated
 * `name[]=` field.
 */
export function ghGraphqlArgs(query: string, variables: GraphQLVariables = {}): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value === "number") {
      args.push("-F", `${name}=${value}`);
    } else if (typeof value === "string") {
      args.push("-f", `${name}=${value}`);
    } else {
      for (const entry of value) args.push("-f", `${name}[]=${entry}`);
    }
  }
  return args;
}

export function describeGhFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return "GitHub CLI (gh) is not installed or not on the bb server's PATH.";
    }
  }
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
  if (stderr.includes("gh auth login") || stderr.toLowerCase().includes("authentication")) {
    return "GitHub CLI is not authenticated. Run `gh auth login` on the machine running bb.";
  }
  if (stderr !== "") return stderr;
  return error instanceof Error ? error.message : String(error);
}

/** `signal` kills the subprocess when it fires, for a caller with a deadline. */
export async function runGh(args: readonly string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      maxBuffer: MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    return stdout;
  } catch (error) {
    throw new Error(describeGhFailure(error));
  }
}

/** One GraphQL request through `run`, answering its `data`. */
export async function ghGraphql(
  run: (args: readonly string[]) => Promise<string>,
  query: string,
  variables?: GraphQLVariables,
): Promise<unknown> {
  const parsed: unknown = JSON.parse(await run(ghGraphqlArgs(query, variables)));
  return (parsed as { data?: unknown }).data;
}

/** `gh auth token`, for the one request that needs the token itself: an image on github.com. */
export async function ghToken(
  run: (args: readonly string[], signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  const token = (await run(["auth", "token"], signal)).trim();
  if (token === "") throw new Error("GitHub CLI has no token for this account.");
  return token;
}
