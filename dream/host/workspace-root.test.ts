import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { bbDataRoot, dreamWorkspacesRoot, insideBbData } from "./workspace-root";

describe("dreamWorkspacesRoot", () => {
  it("is the platform's per-user cache folder", () => {
    expect(dreamWorkspacesRoot("darwin", "/Users/u", {})).toBe("/Users/u/Library/Caches/bb-dream/workspaces");
    expect(dreamWorkspacesRoot("linux", "/home/u", {})).toBe("/home/u/.cache/bb-dream/workspaces");
    expect(dreamWorkspacesRoot("linux", "/home/u", { XDG_CACHE_HOME: "/xdg" })).toBe("/xdg/bb-dream/workspaces");
    expect(dreamWorkspacesRoot("linux", "/home/u", { XDG_CACHE_HOME: "relative" })).toBe("/home/u/.cache/bb-dream/workspaces");
  });
});

describe("insideBbData", () => {
  it("finds bb's data folder from the plugin's host data folder", () => {
    expect(bbDataRoot("/Users/u/.bb/plugins/dream/host-data")).toBe("/Users/u/.bb");
  });

  it("flags the old workspace location, the one bb answered 409 for, and not the new one", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-root-")));
    try {
      const home = path.join(root, "home");
      const data = path.join(home, ".bb");
      mkdirSync(path.join(data, "plugins", "dream", "host-data"), { recursive: true });
      expect(insideBbData(data, path.join(data, "plugins", "dream", "host-data", "workspaces", "proj_x"))).toBe(true);
      expect(insideBbData(data, path.join(dreamWorkspacesRoot("darwin", home, {}), "proj_x"))).toBe(false);
      // bb's own check compares paths as spelled; this one sees through a symlinked spelling.
      symlinkSync(data, path.join(root, "alias"));
      expect(insideBbData(path.join(root, "alias"), path.join(data, "plugins", "dream", "host-data", "workspaces"))).toBe(true);
      expect(insideBbData(data, path.join(root, "alias", "plugins", "x"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
