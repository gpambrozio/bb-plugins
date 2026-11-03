/** Which project "New thread" starts on, from the shell's directory and what came before. */
import { describe, expect, it } from "vitest";

import { comparablePath, defaultProject, directoryFromOsc7, projectForDirectory } from "./project-match";

describe("directoryFromOsc7", () => {
  it("reads the path of a file URL, decoded", () => {
    expect(directoryFromOsc7("file://mini.local/Users/me/My%20Code/app")).toBe("/Users/me/My Code/app");
    expect(directoryFromOsc7("file:///Users/me")).toBe("/Users/me");
  });

  it("reads a Windows drive path", () => {
    expect(directoryFromOsc7("file:///C:/Users/me")).toBe("C:/Users/me");
  });

  it("is null for anything that is not a file URL", () => {
    expect(directoryFromOsc7("/Users/me")).toBeNull();
    expect(directoryFromOsc7("https://example.com/x")).toBeNull();
    expect(directoryFromOsc7("file://host/%E0%A4%A")).toBeNull();
  });
});

describe("projectForDirectory", () => {
  const places = [
    { projectId: "app", hostId: "mini", path: "/Users/me/code/app" },
    { projectId: "app-worktree", hostId: "mini", path: "/Users/me/code/app/.worktrees/feature/" },
    { projectId: "other", hostId: "air", path: "/Users/me/code/app" },
  ];

  it("picks the project whose checkout holds the directory on the tab's machine", () => {
    expect(projectForDirectory("/Users/me/code/app/src", "mini", places)).toBe("app");
    expect(projectForDirectory("/Users/me/code/app", "air", places)).toBe("other");
  });

  it("prefers the deepest directory, so a worktree wins over its checkout", () => {
    expect(projectForDirectory("/Users/me/code/app/.worktrees/feature/lib", "mini", places)).toBe("app-worktree");
  });

  it("matches whole path segments only", () => {
    expect(projectForDirectory("/Users/me/code/application", "mini", places)).toBeNull();
  });

  it("is null without a directory or a match", () => {
    expect(projectForDirectory(null, "mini", places)).toBeNull();
    expect(projectForDirectory("/tmp", "mini", places)).toBeNull();
    expect(projectForDirectory("/Users/me/code/app", "studio", places)).toBeNull();
  });
});

describe("a Windows machine", () => {
  const places = [
    { projectId: "app", hostId: "pc", path: "C:\\Users\\me\\code\\app" },
    { projectId: "app-worktree", hostId: "pc", path: "C:\\Users\\me\\code\\app\\.worktrees\\feature\\" },
    { projectId: "data", hostId: "pc", path: "D:\\" },
  ];

  it("matches the directory a shell reports through OSC 7 to the project's native path", () => {
    const cwd = directoryFromOsc7("file://PC/C:/Users/me/code/app/src");
    expect(cwd).toBe("C:/Users/me/code/app/src");
    expect(projectForDirectory(cwd, "pc", places)).toBe("app");
  });

  it("ignores case and the kind of slash, as Windows does, and prefers the deepest directory", () => {
    expect(projectForDirectory("c:\\users\\ME\\Code\\App\\.worktrees\\feature\\lib", "pc", places)).toBe("app-worktree");
    expect(projectForDirectory(directoryFromOsc7("file:///d:/scratch"), "pc", places)).toBe("data");
  });

  it("matches whole path segments only", () => {
    expect(projectForDirectory("C:/Users/me/code/application", "pc", places)).toBeNull();
    expect(projectForDirectory("E:/Users/me/code/app", "pc", places)).toBeNull();
  });
});

describe("comparablePath", () => {
  it("keeps POSIX paths as they are, case and backslashes included, but for a trailing slash", () => {
    expect(comparablePath("/Users/Me/a\\b/")).toBe("/Users/Me/a\\b");
    expect(comparablePath("/")).toBe("/");
  });

  it("spells a Windows path one way, keeping a drive's root", () => {
    expect(comparablePath("C:\\Users\\Me\\")).toBe("c:/users/me");
    expect(comparablePath("C:\\")).toBe("c:/");
    expect(comparablePath("C:")).toBe("c:/");
  });
});

describe("defaultProject", () => {
  const available = ["a", "b", "c"];

  it("takes the terminal's project, then the last one picked, then the most recent thread's, then the first", () => {
    expect(defaultProject({ available, fromDirectory: "b", lastUsed: "c", mostRecentThread: "a" })).toBe("b");
    expect(defaultProject({ available, fromDirectory: null, lastUsed: "c", mostRecentThread: "a" })).toBe("c");
    expect(defaultProject({ available, fromDirectory: null, lastUsed: null, mostRecentThread: "b" })).toBe("b");
    expect(defaultProject({ available, fromDirectory: null, lastUsed: null, mostRecentThread: null })).toBe("a");
  });

  it("skips a project that is gone", () => {
    expect(defaultProject({ available, fromDirectory: "gone", lastUsed: "gone", mostRecentThread: "c" })).toBe("c");
    expect(defaultProject({ available: [], fromDirectory: "a", lastUsed: null, mostRecentThread: null })).toBeNull();
  });
});
