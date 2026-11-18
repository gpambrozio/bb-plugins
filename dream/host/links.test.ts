import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { danglingLinks, memoryNames } from "./links";

let dir: string;

function write(relative: string, content: string): void {
  const file = path.join(dir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function memory(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: "${name}"\n---\n${body}\n`;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-links-")));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("memory names", () => {
  it("are each file's name, with and without its folder, and its front matter name", () => {
    write("project_ask_tab.md", memory("ask-tab-issue-121", "x"));
    write("notes/build.md", "no front matter");
    expect(memoryNames(dir)).toEqual(["ask-tab-issue-121", "build", "notes/build", "project_ask_tab"]);
  });
});

describe("dangling links", () => {
  it("finds the links a dream left to memories it deleted, by front matter name, file name and path", () => {
    // Before: three memories; the dream deleted two of them and left links to both behind.
    write("project_ask_tab_issue_121.md", memory("ask-tab-issue-121", "the ask tab"));
    write("project_watch_db_orphans.md", memory("project-watch-db-orphans", "orphans"));
    write("reference_devicectl.md", memory("devicectl", "see [[project-watch-db-orphans]]"));
    const before = memoryNames(dir);
    rmSync(path.join(dir, "project_ask_tab_issue_121.md"));
    rmSync(path.join(dir, "project_watch_db_orphans.md"));
    write("reference_foundation_models.md", memory("foundation", "an [[ask-tab-issue-121|Ask tab]] note"));
    write("project_simulator.md", memory("simulator", "([[project_ask_tab_issue_121]]) in a simulator"));
    write("MEMORY.md", "- [Ask](project_ask_tab_issue_121.md) — gone\n- [Devicectl](reference_devicectl.md) — here\n");

    expect(danglingLinks(dir, before)).toEqual([
      { file: "MEMORY.md", link: "project_ask_tab_issue_121.md" },
      { file: "project_simulator.md", link: "[[project_ask_tab_issue_121]]" },
      { file: "reference_devicectl.md", link: "[[project-watch-db-orphans]]" },
      { file: "reference_foundation_models.md", link: "[[ask-tab-issue-121|Ask tab]]" },
    ]);
  });

  it("leaves a [[name]] with no memory yet alone: the memory format allows it", () => {
    write("a.md", memory("a", "see [[worth-writing-later]]"));
    expect(danglingLinks(dir, memoryNames(dir))).toEqual([]);
  });

  it("ignores URLs, anchors, other files, links out of the folder and links inside code", () => {
    write("b.md", "b");
    write(
      "a.md",
      [
        "[site](https://example.com/x.md) [top](#top) [pic](./file.png) [up](../outside.md) [ok](b.md) [ok too](./b.md#part)",
        "`[inline](missing-inline.md)`",
        "```",
        "[fenced](missing-fenced.md) [[b]]",
        "```",
      ].join("\n"),
    );
    expect(danglingLinks(dir, ["missing-fenced"])).toEqual([]);
  });

  it("resolves a Markdown link from the linking file's folder", () => {
    write("topics/a.md", "[sibling](b.md) [root](../MEMORY.md)");
    write("topics/b.md", "b");
    write("MEMORY.md", "[a](topics/a.md) [gone](topics/c.md)");
    expect(danglingLinks(dir, [])).toEqual([{ file: "MEMORY.md", link: "topics/c.md" }]);
  });
});
