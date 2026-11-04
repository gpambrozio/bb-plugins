import { describe, expect, it } from "vitest";

import { DEFAULT_EXCLUDE_PATTERNS, DEFAULT_SCHEMA_PATTERNS } from "./settings";
import { candidates, newSourceFiles, PathRules, relativize, schemaPaths, type TurnFacts } from "./signals";

const rules = { exclude: new PathRules(DEFAULT_EXCLUDE_PATTERNS), schema: new PathRules(DEFAULT_SCHEMA_PATTERNS) };
const all = { commit: true, newFiles: true, schema: true, prMerged: true, streak: true };

function facts(overrides: Partial<TurnFacts> = {}): TurnFacts {
  return { commits: [], committedFiles: [], fileChanges: [], mergedPullRequest: null, changedTurnsSinceOffer: 0, threadTitle: "Add retries", ...overrides };
}

describe("relativize", () => {
  it("strips the workspace root, in either spelling of a macOS temp path", () => {
    expect(relativize("/var/folders/x/repo/src/a.ts", "/var/folders/x/repo")).toBe("src/a.ts");
    // Claude Code reports /private/var/… for a workspace bb knows as /var/… (spike).
    expect(relativize("/private/var/folders/x/repo/src/a.ts", "/var/folders/x/repo")).toBe("src/a.ts");
    expect(relativize("/var/folders/x/repo/src/a.ts", "/private/var/folders/x/repo/")).toBe("src/a.ts");
  });

  it("drops a path outside the workspace and keeps a relative one", () => {
    expect(relativize("/etc/passwd", "/work/repo")).toBeNull();
    expect(relativize("/work/repository/a.ts", "/work/repo")).toBeNull();
    expect(relativize("./src/a.ts", "/work/repo")).toBe("src/a.ts");
    expect(relativize("/work/repo/a.ts", null)).toBeNull();
  });
});

describe("PathRules", () => {
  it("matches gitignore patterns anywhere in the tree", () => {
    expect(rules.exclude.matches("README.md")).toBe(true);
    expect(rules.exclude.matches("docs/guide.md")).toBe(true);
    expect(rules.exclude.matches("web/package-lock.json")).toBe(true);
    expect(rules.exclude.matches("src/__snapshots__/a.test.ts.snap")).toBe(true);
    expect(rules.exclude.matches("vendor/lib/x.go")).toBe(true);
    expect(rules.exclude.matches("src/retry.ts")).toBe(false);
    expect(rules.schema.matches("db/migrations/0003_users.sql")).toBe(true);
    expect(rules.schema.matches("prisma/schema.prisma")).toBe(true);
    expect(rules.schema.matches("api/openapi.yaml")).toBe(true);
    expect(rules.schema.matches("src/retry.ts")).toBe(false);
  });

  it("ignores blank lines and comments, and an empty list matches nothing", () => {
    expect(new PathRules("\n# comment\n\n").matches("anything.ts")).toBe(false);
    expect(new PathRules("# only a comment\n*.ts").matches("a.ts")).toBe(true);
  });
});

describe("what a turn did", () => {
  it("new source files come from commits and edits, without excluded ones, once each", () => {
    const paths = newSourceFiles(
      {
        committedFiles: [
          { path: "src/retry.ts", status: "A" },
          { path: "src/old.ts", status: "M" },
          { path: "package-lock.json", status: "A" },
        ],
        fileChanges: [
          { kind: "add", path: "src/retry.ts" },
          { kind: "add", path: "src/backoff.ts" },
          { kind: "update", path: "src/index.ts" },
          { kind: "add", path: "NOTES.md" },
        ],
      },
      rules.exclude,
    );
    expect(paths).toEqual(["src/retry.ts", "src/backoff.ts"]);
  });

  it("schema paths come from any change", () => {
    expect(schemaPaths({ committedFiles: [{ path: "db/migrations/1.sql", status: "M" }], fileChanges: [{ kind: "delete", path: "api/x.proto" }] }, rules.schema)).toEqual([
      "db/migrations/1.sql",
      "api/x.proto",
    ]);
  });
});

describe("candidates", () => {
  it("lists every trigger, merged pull request first, then commit, schema, new files, streak", () => {
    const found = candidates(
      facts({
        mergedPullRequest: { url: "https://github.com/acme/calc/pull/7", title: "Retry turns" },
        commits: [
          { sha: "abc1234def", subject: "Retry turns after a rate limit" },
          { sha: "bcd2345efa", subject: "Test retries" },
        ],
        committedFiles: [{ path: "db/migrations/1.sql", status: "A" }],
        fileChanges: [{ kind: "add", path: "src/retry.ts" }],
        changedTurnsSinceOffer: 9,
      }),
      all,
      rules,
      8,
    );
    expect(found.map((candidate) => candidate.trigger)).toEqual(["pr-merged", "commit", "schema", "new-files", "streak"]);
    expect(found[0]).toMatchObject({ topic: '"Retry turns"', refs: { prUrl: "https://github.com/acme/calc/pull/7" } });
    expect(found[1]).toMatchObject({ topic: '"Retry turns after a rate limit" and 1 more' });
    expect(found[3]).toMatchObject({ topic: "the new `db/migrations/1.sql` and `src/retry.ts`" });
  });

  it("names at most two paths and counts the rest", () => {
    const found = candidates(facts({ fileChanges: ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ kind: "add" as const, path })) }), all, rules, 8);
    expect(found).toEqual([{ trigger: "new-files", topic: "the new `a.ts` and `b.ts` and 2 more", refs: { paths: ["a.ts", "b.ts", "c.ts", "d.ts"] } }]);
  });

  it("leaves out turned-off triggers, and a streak below the threshold", () => {
    const busy = facts({ commits: [{ sha: "abc", subject: "x" }], fileChanges: [{ kind: "add", path: "src/a.ts" }], changedTurnsSinceOffer: 7 });
    expect(candidates(busy, { ...all, commit: false }, rules, 8).map((candidate) => candidate.trigger)).toEqual(["new-files"]);
    expect(candidates(busy, { ...all, commit: false, newFiles: false }, rules, 8)).toEqual([]);
  });

  it("finds nothing in a turn that only edited docs and lockfiles", () => {
    expect(candidates(facts({ fileChanges: [{ kind: "add", path: "README.md" }, { kind: "add", path: "yarn.lock" }] }), all, rules, 8)).toEqual([]);
  });

  it("quotes and shortens a long subject", () => {
    const subject = "x".repeat(200);
    const [found] = candidates(facts({ commits: [{ sha: "abc", subject }] }), all, rules, 8);
    expect(found!.topic.length).toBeLessThan(125);
    expect(found!.topic.endsWith('…"')).toBe(true);
  });
});
