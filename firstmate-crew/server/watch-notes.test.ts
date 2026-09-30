import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KEPT_NOTES, saveWatchNote, watchNoteLine } from "./watch-notes";

describe("watchNoteLine", () => {
  it("names the one watch", () => {
    expect(watchNoteLine([{ name: "pr-watch", kind: "output" }], 0)).toBe("Watch note from pr-watch");
  });

  it("counts the notes and names each watch once, in order", () => {
    expect(
      watchNoteLine(
        [
          { name: "pr-watch", kind: "output" },
          { name: "disk-check", kind: "output" },
          { name: "pr-watch", kind: "output" },
        ],
        0,
      ),
    ).toBe("3 watch notes from pr-watch, disk-check");
  });

  it("marks a watch whose run failed", () => {
    expect(
      watchNoteLine(
        [
          { name: "pr-watch", kind: "failed" },
          { name: "disk-check", kind: "output" },
        ],
        0,
      ),
    ).toBe("2 watch notes from pr-watch (failed), disk-check");
  });

  it("adds the older notes that were dropped", () => {
    expect(watchNoteLine([{ name: "pr-watch", kind: "output" }], 2)).toBe("Watch note from pr-watch · 2 older dropped");
  });

  it("says only what was dropped when nothing else goes", () => {
    expect(watchNoteLine([], 1)).toBe("1 older watch note dropped");
    expect(watchNoteLine([], 4)).toBe("4 older watch notes dropped");
  });
});

describe("saveWatchNote", () => {
  let directory: string;

  beforeEach(async () => {
    directory = join(await mkdtemp(join(tmpdir(), "fm-notes-")), "watch-notes");
  });

  afterEach(async () => {
    await rm(join(directory, ".."), { recursive: true, force: true });
  });

  it("writes the note under a name from its time, creating the folder", async () => {
    const name = await saveWatchNote(directory, "the whole note", new Date("2026-09-30T06:40:12.345Z"));
    expect(name).toBe("2026-09-30T06-40-12Z.md");
    await expect(readFile(join(directory, name), "utf8")).resolves.toBe("the whole note");
  });

  it("never overwrites a note from the same second", async () => {
    const at = new Date("2026-09-30T06:40:12Z");
    const first = await saveWatchNote(directory, "first", at);
    const second = await saveWatchNote(directory, "second", at);
    expect(second).toBe("2026-09-30T06-40-12Z-2.md");
    await expect(readFile(join(directory, first), "utf8")).resolves.toBe("first");
    await expect(readFile(join(directory, second), "utf8")).resolves.toBe("second");
  });

  it(`keeps only the newest ${KEPT_NOTES} notes and leaves other files alone`, async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "README.txt"), "not a note");
    for (let minute = 0; minute < KEPT_NOTES; minute += 1) {
      await writeFile(join(directory, `2026-09-29T10-${String(minute).padStart(2, "0")}-00Z.md`), "old");
    }

    await saveWatchNote(directory, "newest", new Date("2026-09-30T06:40:12Z"));

    const files = (await readdir(directory)).sort();
    expect(files).toHaveLength(KEPT_NOTES + 1);
    expect(files).toContain("README.txt");
    expect(files).not.toContain("2026-09-29T10-00-00Z.md");
    expect(files).toContain("2026-09-30T06-40-12Z.md");
  });
});
