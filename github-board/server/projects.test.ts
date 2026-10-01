import { describe, expect, it, vi } from "vitest";

import { buildProjectIndex, preferredProject, type ProjectRecord } from "./projects";

const LOCAL = "host_local";
const REMOTE = "host_remote";

function project(
  id: string,
  gitRemoteUrl: string | null,
  sources: { hostId: string; path: string }[],
  kind = "standard",
): ProjectRecord {
  return { id, name: id, kind, gitRemoteUrl, sources };
}

describe("buildProjectIndex", () => {
  it("matches on the recorded origin first, on every machine, without asking git", async () => {
    const remotesOf = vi.fn(async () => []);
    const index = await buildProjectIndex(
      [
        project("mini", "git@github.com:me/app.git", [{ hostId: LOCAL, path: "/a" }]),
        project("laptop", "https://github.com/me/app", [{ hostId: REMOTE, path: "/b" }]),
      ],
      LOCAL,
      remotesOf,
    );
    expect(index.byRepositoryId.get("github.com/me/app")?.map((p) => p.id)).toEqual(["mini", "laptop"]);
    expect(remotesOf).toHaveBeenCalledWith("/a");
    expect(remotesOf).not.toHaveBeenCalledWith("/b");
  });

  it("finds a fork's upstream in the local checkout's other remotes", async () => {
    const index = await buildProjectIndex(
      [project("paseo", "git@github.com:me/paseo.git", [{ hostId: LOCAL, path: "/paseo" }])],
      LOCAL,
      async () => ["github.com/me/paseo", "github.com/getpaseo/paseo"],
    );
    expect(index.byRepositoryId.get("github.com/getpaseo/paseo")?.map((p) => p.id)).toEqual(["paseo"]);
  });

  it("lets no remote scan claim a repository some project has as its origin", async () => {
    const index = await buildProjectIndex(
      [
        project("fork", "git@github.com:me/lib.git", [{ hostId: LOCAL, path: "/fork" }]),
        project("upstream", "git@github.com:org/lib.git", [{ hostId: REMOTE, path: "/up" }]),
      ],
      LOCAL,
      async (path) => (path === "/fork" ? ["github.com/me/lib", "github.com/org/lib"] : []),
    );
    expect(index.byRepositoryId.get("github.com/org/lib")?.map((p) => p.id)).toEqual(["upstream"]);
  });

  it("skips the personal project and scans nothing without a local machine", async () => {
    const remotesOf = vi.fn(async () => ["github.com/x/y"]);
    const index = await buildProjectIndex(
      [project("personal", "git@github.com:x/y.git", [{ hostId: LOCAL, path: "/p" }], "personal")],
      null,
      remotesOf,
    );
    expect(index.byRepositoryId.size).toBe(0);
    expect(remotesOf).not.toHaveBeenCalled();
  });
});

describe("preferredProject", () => {
  const laptop = { id: "laptop", name: "laptop", hostIds: [REMOTE] };
  const mini = { id: "mini", name: "mini", hostIds: [LOCAL] };

  it("prefers the project with a checkout on the server's machine", () => {
    expect(preferredProject([laptop, mini], LOCAL)).toBe(mini);
    expect(preferredProject([laptop], LOCAL)).toBe(laptop);
    expect(preferredProject([], LOCAL)).toBeNull();
  });
});
