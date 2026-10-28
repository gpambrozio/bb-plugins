import { describe, expect, it } from "vitest";

import { describeGhFailure, GhError, ghGraphql, ghGraphqlArgs, ghRunner, ghToken, isGhMissing, type ExecFile } from "./gh";

describe("ghGraphqlArgs", () => {
  it("sends strings raw, integers typed and lists as repeated fields", () => {
    expect(ghGraphqlArgs("query", { mine: "author:x", limit: 30, ids: ["A", "B"], flag: "true" })).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query",
      "-f",
      "mine=author:x",
      "-F",
      "limit=30",
      "-f",
      "ids[]=A",
      "-f",
      "ids[]=B",
      "-f",
      "flag=true",
    ]);
  });
});

describe("ghGraphql", () => {
  it("answers the response's data", async () => {
    const data = await ghGraphql(async () => JSON.stringify({ data: { viewer: { login: "x" } } }), "q");
    expect(data).toEqual({ viewer: { login: "x" } });
  });
});

describe("ghToken", () => {
  it("trims the token and refuses an empty one", async () => {
    const signal = new AbortController().signal;
    expect(await ghToken(async () => "gho_abc\n", signal)).toBe("gho_abc");
    await expect(ghToken(async () => "\n", signal)).rejects.toThrow(/no token/);
  });
});

describe("describeGhFailure", () => {
  it("says what to do about a missing or signed-out gh", () => {
    expect(describeGhFailure(Object.assign(new Error("spawn gh"), { code: "ENOENT" }))).toMatch(/was not found/);
    expect(describeGhFailure({ stderr: "To get started with GitHub CLI, please run:  gh auth login" })).toMatch(
      /not authenticated/,
    );
    expect(describeGhFailure({ stderr: "GraphQL: Could not resolve to a node\n" })).toBe(
      "GraphQL: Could not resolve to a node",
    );
  });
});

describe("ghRunner", () => {
  it("runs gh by name through the injected exec, with a timeout and the caller's signal", async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Parameters<ExecFile>[2] }> = [];
    const exec: ExecFile = async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "out" };
    };
    const signal = new AbortController().signal;
    expect(await ghRunner(exec)(["auth", "token"], signal)).toBe("out");
    expect(await ghRunner(exec)(["api", "graphql"])).toBe("out");
    // By name, not by a path found at load: bb's toolchain resolves it per call.
    expect(calls.map((call) => [call.file, call.args])).toEqual([
      ["gh", ["auth", "token"]],
      ["gh", ["api", "graphql"]],
    ]);
    expect(calls[0]!.options).toMatchObject({ encoding: "utf8", timeout: 30_000, signal });
    expect(calls[1]!.options).not.toHaveProperty("signal");
  });

  it("describes a failure, says whether gh is missing, and drops the original error and its output", async () => {
    const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    const runMissing = ghRunner(async () => {
      throw missing;
    });
    const error = await runMissing(["auth", "status"]).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GhError);
    expect((error as Error).message).toMatch(/was not found/);
    expect(isGhMissing(error)).toBe(true);

    const signedOut = Object.assign(new Error("exit 1"), { code: 1, stderr: "run gh auth login" });
    const runSignedOut = ghRunner(async () => {
      throw signedOut;
    });
    const second = await runSignedOut(["auth", "status"]).catch((caught: unknown) => caught);
    expect((second as Error).message).toMatch(/not authenticated/);
    expect(isGhMissing(second)).toBe(false);

    // A failed `gh auth token` may have printed the token; nothing of the run survives but the message.
    const leaky = Object.assign(new Error("exit 1"), { code: 1, stdout: "gho_secret", stderr: "boom" });
    const third = await ghRunner(async () => {
      throw leaky;
    })(["auth", "token"]).catch((caught: unknown) => caught);
    expect((third as Error).message).toBe("boom");
    expect((third as Error).cause).toBeUndefined();
    expect(JSON.stringify(third)).not.toContain("gho_secret");
    expect(Object.values(third as object)).not.toContain("gho_secret");
  });
});
