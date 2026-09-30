/**
 * The answers here are trimmed copies of what GitHub really returned for the
 * branch-status query on 2026-09-22 — a same-repository pull request, one from a
 * fork, one on a repository with "Always suggest updating pull request
 * branches" off, and one with conflicts. Nothing in this file fetches.
 */
import { describe, expect, it } from "vitest";

import { branchStatusQuery, toBranchStatus } from "./github";

describe("branchStatusQuery", () => {
  it("declares one id and one head variable for every alias it selects", () => {
    const query = branchStatusQuery(3);
    for (const index of [0, 1, 2]) {
      expect(query).toContain(`$id${index}: ID!`);
      expect(query).toContain(`$head${index}: String!`);
      expect(query).toContain(`pr${index}: node(id: $id${index})`);
      expect(query).toContain(`compare(headRef: $head${index})`);
      expect(query).toContain("mergeable");
      expect(query).toContain("repository { viewerPermission }");
    }
    expect(query).not.toContain("pr3");
  });
});

describe("toBranchStatus", () => {
  it("reads a branch that is behind and that the login may update", () => {
    // gpambrozio/SurfTracker#168: behind main, repository allows updating.
    const node = {
      mergeable: "MERGEABLE",
      viewerCanUpdateBranch: true,
      baseRef: { compare: { behindBy: 2 } },
    };
    expect(toBranchStatus(node)).toEqual({ behindBy: 2, canUpdate: true, conflicts: false });
  });

  it("reads a pull request from a fork the same way", () => {
    // getpaseo/paseo#5039, head on gpambrozio/paseo, compared by head SHA.
    const node = {
      mergeable: "MERGEABLE",
      viewerCanUpdateBranch: true,
      baseRef: { compare: { behindBy: 25 } },
    };
    expect(toBranchStatus(node)).toEqual({ behindBy: 25, canUpdate: true, conflicts: false });
  });

  it("offers the update to a writer where the repository does not suggest it", () => {
    // gpambrozio/SquarelineToEsphome#23: clean and behind, but the repository
    // has "Always suggest updating pull request branches" off, so GitHub
    // answers false. The update works anyway for someone who can push there
    // (tested on 2026-09-30 with a throwaway pull request on that repository).
    const node = {
      mergeable: "MERGEABLE",
      viewerCanUpdateBranch: false,
      repository: { viewerPermission: "ADMIN" },
      baseRef: { compare: { behindBy: 2 } },
    };
    expect(toBranchStatus(node)).toEqual({ behindBy: 2, canUpdate: true, conflicts: false });
    for (const permission of ["WRITE", "MAINTAIN"]) {
      expect(toBranchStatus({ ...node, repository: { viewerPermission: permission } })?.canUpdate).toBe(true);
    }
  });

  it("keeps the count but offers no update without write access", () => {
    const node = {
      mergeable: "MERGEABLE",
      viewerCanUpdateBranch: false,
      baseRef: { compare: { behindBy: 2 } },
    };
    for (const permission of ["READ", "TRIAGE", null]) {
      expect(toBranchStatus({ ...node, repository: { viewerPermission: permission } })).toEqual({
        behindBy: 2,
        canUpdate: false,
        conflicts: false,
      });
    }
    expect(toBranchStatus({ ...node, repository: null })?.canUpdate).toBe(false);
  });

  it("offers no update to a writer on a branch with conflicts", () => {
    const node = {
      mergeable: "CONFLICTING",
      viewerCanUpdateBranch: false,
      repository: { viewerPermission: "ADMIN" },
      baseRef: { compare: { behindBy: 4 } },
    };
    expect(toBranchStatus(node)).toEqual({ behindBy: 4, canUpdate: false, conflicts: true });
  });

  it("never offers an update on a branch that is not behind", () => {
    const node = {
      mergeable: "MERGEABLE",
      viewerCanUpdateBranch: true,
      baseRef: { compare: { behindBy: 0 } },
    };
    expect(toBranchStatus(node)).toEqual({ behindBy: 0, canUpdate: false, conflicts: false });
  });

  it("offers no update on a branch with conflicts, though GitHub's own flag does", () => {
    // getpaseo/paseo#3339: GitHub says the viewer can update the branch, and
    // the update it offers fails, because the branch conflicts with main.
    const node = {
      mergeable: "CONFLICTING",
      viewerCanUpdateBranch: true,
      baseRef: { compare: { behindBy: 48 } },
    };
    expect(toBranchStatus(node)).toEqual({ behindBy: 48, canUpdate: false, conflicts: true });
  });

  it("reads a merge state GitHub has not computed yet as no known conflicts", () => {
    const node = {
      mergeable: "UNKNOWN",
      viewerCanUpdateBranch: true,
      baseRef: { compare: { behindBy: 3 } },
    };
    expect(toBranchStatus(node)).toEqual({ behindBy: 3, canUpdate: true, conflicts: false });
  });

  it("is null when GitHub had no comparison to give", () => {
    expect(toBranchStatus({ viewerCanUpdateBranch: false, baseRef: null })).toBeNull();
    expect(toBranchStatus({ viewerCanUpdateBranch: false, baseRef: { compare: null } })).toBeNull();
    expect(toBranchStatus(null)).toBeNull();
    expect(toBranchStatus(undefined)).toBeNull();
  });
});
