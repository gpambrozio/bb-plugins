import { describe, expect, it } from "vitest";

import type { Board, BoardItem } from "../shared/board";
import { linkedIssueLabel, patchBoard, repositoriesOf, staleBranch, visibleColumns } from "./board-logic";

function item(id: string, repository: string, extra: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    number: 1,
    title: id,
    url: `https://github.com/${repository}/issues/1`,
    repository,
    updatedAt: "",
    commentsCount: 0,
    labels: [],
    author: null,
    detail: null,
    linkedIssues: [],
    checks: null,
    branch: null,
    ...extra,
  };
}

function board(columns: Partial<Record<"issues" | "draft-prs" | "open-prs" | "discussions", BoardItem[]>>, errors: Partial<Record<string, string>> = {}): Board {
  const ids = ["issues", "draft-prs", "open-prs", "discussions"] as const;
  return {
    login: "me",
    fetchedAt: "",
    repositoryProjects: {},
    columns: ids.map((id) => ({ id, title: id, items: columns[id] ?? [], error: errors[id] ?? null })),
  };
}

const ids = (columns: ReturnType<typeof visibleColumns>) =>
  columns.map((column) => [column.id, column.items.map((entry) => entry.id)]);

describe("visibleColumns", () => {
  it("folds an issue into the pull request that closes it, drafts included", () => {
    const issue = item("I1", "o/r");
    const pr = item("P1", "o/r", { linkedIssues: [{ id: "I1", number: 1, repository: "o/r" }] });
    expect(ids(visibleColumns(board({ issues: [issue, item("I2", "o/r")], "draft-prs": [pr] }), new Set()))).toEqual([
      ["issues", ["I2"]],
      ["draft-prs", ["P1"]],
    ]);
  });

  it("lets a filtered-out pull request stop claiming its issue", () => {
    const issue = item("I1", "o/r");
    const pr = item("P1", "o/other", { linkedIssues: [{ id: "I1", number: 1, repository: "o/r" }] });
    expect(ids(visibleColumns(board({ issues: [issue], "open-prs": [pr] }), new Set(["o/other"])))).toEqual([
      ["issues", ["I1"]],
    ]);
  });

  it("keeps an empty column that failed, and brings every column back when all are empty", () => {
    expect(ids(visibleColumns(board({}, { discussions: "no scope" }), new Set()))).toEqual([["discussions", []]]);
    expect(visibleColumns(board({}), new Set())).toHaveLength(4);
  });
});

describe("the rest", () => {
  it("lists every repository once, sorted, filtered or not", () => {
    expect(repositoriesOf(board({ issues: [item("a", "z/z"), item("b", "a/a")], discussions: [item("c", "z/z")] }))).toEqual([
      "a/a",
      "z/z",
    ]);
  });

  it("patches a card wherever it is", () => {
    const patched = patchBoard(board({ "open-prs": [item("P1", "o/r")] }), "P1", { labels: ["bug"] });
    expect(patched.columns[2]?.items[0]?.labels).toEqual(["bug"]);
  });

  it("names a linked issue's repository only when it differs", () => {
    expect(linkedIssueLabel({ id: "x", number: 3, repository: "o/r" }, "o/r")).toBe("Issue #3");
    expect(linkedIssueLabel({ id: "x", number: 3, repository: "o/lib" }, "o/r")).toBe("Issue o/lib#3");
  });

  it("puts a pill on a branch that is behind or conflicts, and none on one up to date", () => {
    expect(staleBranch({ behindBy: 0, canUpdate: false, conflicts: false })).toBeNull();
    expect(staleBranch({ behindBy: 0, canUpdate: false, conflicts: true })).not.toBeNull();
    expect(staleBranch(null)).toBeNull();
  });
});
