import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WATCH_NOTES_FOLDER } from "../shared/types";
import { KEPT_NOTES, parseWatchNote, readWatchNote, saveWatchNote, watchNoteLine } from "./watch-notes";
import { watchNote, type QueuedNote } from "./watches";

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
  let home: string;
  let directory: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fm-notes-"));
    directory = join(home, WATCH_NOTES_FOLDER);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the note under a name from its time, creating the folder", async () => {
    const name = await saveWatchNote(home, "the whole note", new Date("2026-09-30T06:40:12.345Z"));
    expect(name).toBe("2026-09-30T06-40-12Z.md");
    await expect(readFile(join(directory, name), "utf8")).resolves.toBe("the whole note");
  });

  it("never overwrites a note from the same second", async () => {
    const at = new Date("2026-09-30T06:40:12Z");
    const first = await saveWatchNote(home, "first", at);
    const second = await saveWatchNote(home, "second", at);
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

    await saveWatchNote(home, "newest", new Date("2026-09-30T06:40:12Z"));

    const files = (await readdir(directory)).sort();
    expect(files).toHaveLength(KEPT_NOTES + 1);
    expect(files).toContain("README.txt");
    expect(files).not.toContain("2026-09-29T10-00-00Z.md");
    expect(files).toContain("2026-09-30T06-40-12Z.md");
  });

  it("refuses a notes folder that is a link out of the home, and writes and deletes nothing there", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fm-outside-"));
    try {
      const victim = join(outside, "2026-09-29T10-00-00Z.md");
      await writeFile(victim, "not the plugin's");
      await mkdir(join(home, ".firstmate"), { recursive: true });
      await symlink(outside, directory);

      await expect(saveWatchNote(home, "note", new Date("2026-09-30T06:40:12Z"))).rejects.toThrow(/outside the home/);
      expect(await readdir(outside)).toEqual(["2026-09-29T10-00-00Z.md"]);
      await expect(readFile(victim, "utf8")).resolves.toBe("not the plugin's");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a notes folder that is a link to elsewhere in the home", async () => {
    await mkdir(join(home, "data"), { recursive: true });
    await writeFile(join(home, "data", "2026-09-29T10-00-00Z.md"), "a record");
    await mkdir(join(home, ".firstmate"), { recursive: true });
    await symlink(join(home, "data"), directory);

    await expect(saveWatchNote(home, "note", new Date("2026-09-30T06:40:12Z"))).rejects.toThrow(
      `${WATCH_NOTES_FOLDER} is not a plain folder in the home`,
    );
    await expect(readFile(join(home, "data", "2026-09-29T10-00-00Z.md"), "utf8")).resolves.toBe("a record");
  });
});

describe("parseWatchNote", () => {
  const ran = "2026-09-30T06:40:00Z";

  it("reads back each run of a composed message, without the tags and with the escaping undone", async () => {
    const notes: QueuedNote[] = [
      { name: "pr-watch", ran, kind: "output", text: "Checks turned green\n- <b>one</b> & two" },
      { name: "disk-check", ran, kind: "failed", reason: 'it exited with code 2', text: "df: \"/Volumes/x\": no such file" },
    ];
    expect(parseWatchNote(await watchNote(notes, 3))).toEqual({
      dropped: 3,
      runs: [
        { name: "pr-watch", ran, failed: null, text: "Checks turned green\n- <b>one</b> & two" },
        { name: "disk-check", ran, failed: "it exited with code 2", text: 'df: "/Volumes/x": no such file' },
      ],
    });
  });

  it("reads a failure that wrote nothing to stderr", async () => {
    const text = await watchNote([{ name: "quiet", ran, kind: "failed", reason: "it was killed by a signal", text: "" }], 0);
    expect(parseWatchNote(text).runs).toEqual([
      { name: "quiet", ran, failed: "it was killed by a signal", text: "(nothing on stderr)" },
    ]);
  });

  it("is empty for text that is not a watch message", () => {
    expect(parseWatchNote("just some words")).toEqual({ dropped: 0, runs: [] });
  });
});

describe("readWatchNote", () => {
  let notes: string;

  beforeEach(async () => {
    notes = await mkdtemp(join(tmpdir(), "fm-read-"));
  });

  afterEach(async () => {
    await rm(notes, { recursive: true, force: true });
  });

  it("reads a saved note by its file name", async () => {
    const name = await saveWatchNote(
      notes,
      await watchNote([{ name: "pr-watch", ran: "2026-09-30T06:40:00Z", kind: "output", text: "hi" }], 0),
      new Date("2026-09-30T06:40:12Z"),
    );
    await expect(readWatchNote(notes, name)).resolves.toMatchObject({ runs: [{ name: "pr-watch", text: "hi" }] });
  });

  it("refuses anything but a note's file name", async () => {
    for (const name of ["../watches.json", "/etc/passwd", "2026-09-30T06-40-12Z.md/../../x", "notes.md"]) {
      await expect(readWatchNote(notes, name)).rejects.toThrow(`Not a watch note: ${name}`);
    }
  });

  it("refuses a note that is a link, even to a real note", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fm-outside-"));
    try {
      const secret = join(outside, "secret.md");
      await writeFile(secret, '<firstmate-watch name="x" ran="y">\nnot yours\n</firstmate-watch>');
      await mkdir(join(notes, WATCH_NOTES_FOLDER), { recursive: true });
      await symlink(secret, join(notes, WATCH_NOTES_FOLDER, "2026-09-30T06-40-12Z.md"));

      await expect(readWatchNote(notes, "2026-09-30T06-40-12Z.md")).rejects.toThrow("Not a watch note: 2026-09-30T06-40-12Z.md");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("says so when the note is gone", async () => {
    await expect(readWatchNote(notes, "2026-09-30T06-40-12Z.md")).rejects.toThrow(
      "That watch note is no longer kept; the home keeps the newest 50.",
    );
  });
});
