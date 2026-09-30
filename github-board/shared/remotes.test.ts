import { describe, expect, it } from "vitest";

import { repositoryIdFor } from "./launch";
import { normalizeRemoteUrl, remoteIdsOf } from "./remotes";

describe("normalizeRemoteUrl", () => {
  it.each([
    ["git@github.com:Owner/Repo.git", "github.com/owner/repo"],
    ["https://github.com/owner/repo", "github.com/owner/repo"],
    ["https://github.com/owner/repo.git/", "github.com/owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "github.com/owner/repo"],
    ["https://ghe.example.com:8443/owner/repo", "ghe.example.com:8443/owner/repo"],
  ])("reads %s", (remote, id) => {
    expect(normalizeRemoteUrl(remote)).toBe(id);
  });

  it.each(["", "   ", "not a remote", "https://github.com/"])("refuses %j", (remote) => {
    expect(normalizeRemoteUrl(remote)).toBeNull();
  });

  it("compares equal to a card's repository id", () => {
    expect(normalizeRemoteUrl("git@github.com:getpaseo/paseo.git")).toBe(
      repositoryIdFor("getpaseo/paseo", "https://github.com/getpaseo/paseo/pull/1"),
    );
  });
});

describe("remoteIdsOf", () => {
  it("reads every remote once, upstream included", () => {
    const output = [
      "origin\tgit@github.com:me/paseo.git (fetch)",
      "origin\tgit@github.com:me/paseo.git (push)",
      "upstream\thttps://github.com/getpaseo/paseo.git (fetch)",
      "upstream\thttps://github.com/getpaseo/paseo.git (push)",
      "",
    ].join("\n");
    expect(remoteIdsOf(output)).toEqual(["github.com/me/paseo", "github.com/getpaseo/paseo"]);
  });
});

describe("repositoryIdFor", () => {
  it("takes the host from the card's URL", () => {
    expect(repositoryIdFor("Owner/Repo", "https://ghe.example.com/Owner/Repo/issues/1")).toBe(
      "ghe.example.com/owner/repo",
    );
    expect(repositoryIdFor("no-slash", "https://github.com/x")).toBeNull();
    expect(repositoryIdFor("o/r", "not a url")).toBeNull();
  });
});
