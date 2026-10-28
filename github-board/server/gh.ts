/**
 * `gh api graphql` as a `GitHubApi.graphql`: the GitHub CLI's own login, on
 * whichever machine this module runs on. `gh` exits non-zero on any GraphQL
 * error, which is the behaviour `server/github.ts` relies on.
 */
import { experimental_execHostFile } from "@get-bb/plugin-sdk/process";

import type { GraphQLVariables } from "./github";

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

/** Whether a failed run means there was no `gh` to run at all. */
export function isGhMissing(error: unknown): boolean {
  if (error instanceof Error && error.cause !== undefined) return isGhMissing(error.cause);
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
  );
}

export function describeGhFailure(error: unknown): string {
  if (isGhMissing(error)) {
    return "GitHub CLI (gh) was not found on the machine running bb. Install it (`brew install gh`) and run `gh auth login`.";
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

/** No single `gh` call the board makes should take longer; a hung one is killed. */
const GH_TIMEOUT_MS = 30_000;

export type GhRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

/** How a file is run: `experimental_execHostFile`'s shape, narrowed to what the board passes. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; maxBuffer: number; timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string }>;

/**
 * Runs `gh` through bb's host toolchain, which finds it the way bb finds its
 * own tools: the login shell's PATH, `~/.local/bin`, mise and asdf shims,
 * Volta and Homebrew. It is looked up on every call, and a miss refreshes
 * that lookup in the background, so a `gh` installed after the plugin loaded
 * is found without a reload. `signal` kills the subprocess when it fires, for
 * a caller with a deadline of its own; every call is killed after 30 seconds
 * regardless. A failure keeps the original error as its `cause`.
 */
export function ghRunner(exec: ExecFile = experimental_execHostFile): GhRunner {
  return async (args, signal) => {
    try {
      const { stdout } = await exec("gh", [...args], {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: GH_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      return stdout;
    } catch (error) {
      throw new Error(describeGhFailure(error), { cause: error });
    }
  };
}

/** One GraphQL request through `run`, answering its `data`. */
export async function ghGraphql(
  run: GhRunner,
  query: string,
  variables?: GraphQLVariables,
): Promise<unknown> {
  const parsed: unknown = JSON.parse(await run(ghGraphqlArgs(query, variables)));
  return (parsed as { data?: unknown }).data;
}

/** `gh auth token`, for the one request that needs the token itself: an image on github.com. */
export async function ghToken(run: GhRunner, signal: AbortSignal): Promise<string> {
  const token = (await run(["auth", "token"], signal)).trim();
  if (token === "") throw new Error("GitHub CLI has no token for this account.");
  return token;
}
