import { describe, expect, it } from "vitest";

import { describeGhFailure, ghGraphql, ghGraphqlArgs, ghToken } from "./gh";

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
    expect(describeGhFailure(Object.assign(new Error("spawn gh"), { code: "ENOENT" }))).toMatch(/not installed/);
    expect(describeGhFailure({ stderr: "To get started with GitHub CLI, please run:  gh auth login" })).toMatch(
      /not authenticated/,
    );
    expect(describeGhFailure({ stderr: "GraphQL: Could not resolve to a node\n" })).toBe(
      "GraphQL: Could not resolve to a node",
    );
  });
});
