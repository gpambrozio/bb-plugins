import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDeliver } from "./watch-delivery";
import { fakeLog, fakeThreads, memoryStore } from "./testing/fakes";
import type { OutgoingNote } from "./watches";

const AT = new Date("2026-09-30T06:40:12Z");

const NOTE: OutgoingNote = {
  text: "watch output",
  notes: [{ name: "pr-watch", ran: "2026-09-30T06:40:00Z", kind: "output", text: "watch output" }],
  dropped: 0,
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fm-delivery-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function setup() {
  const threads = fakeThreads();
  const store = memoryStore();
  const log = fakeLog();
  return { threads, store, log, deliver: createDeliver({ threads, store, home, log, now: () => AT }) };
}

describe("createDeliver", () => {
  it("waits, and sends nothing, while no first mate is stored", async () => {
    const { threads, deliver } = setup();
    threads.add({ status: "idle" });

    await expect(deliver(NOTE)).resolves.toBe("wait");
    expect(threads.calls).toEqual([]);
  });

  it("waits while the first mate is mid-turn", async () => {
    const { threads, store, deliver } = setup();
    const mate = threads.add({ status: "active" });
    await store.setMateThreadId(mate.id);

    await expect(deliver(NOTE)).resolves.toBe("wait");
    expect(threads.callsTo("sendShortened")).toEqual([]);
  });

  it("saves the whole note in the home and sends it once, shown as one line, when the first mate is idle", async () => {
    const { threads, store, deliver } = setup();
    const mate = threads.add({ status: "idle" });
    await store.setMateThreadId(mate.id);

    await expect(deliver(NOTE)).resolves.toBe("sent");
    const path = ".firstmate/watch-notes/2026-09-30T06-40-12Z.md";
    expect(threads.callsTo("sendShortened")).toEqual([
      [
        mate.id,
        { shown: "Watch note from pr-watch", file: { path, label: "full note" }, hidden: "watch output" },
        "queue-if-active",
      ],
    ]);
    await expect(readFile(join(home, path), "utf8")).resolves.toBe("watch output");
  });

  it("sends the whole note as it is, and logs why, when it cannot be saved", async () => {
    const { threads, store, log, deliver } = setup();
    const mate = threads.add({ status: "idle" });
    await store.setMateThreadId(mate.id);
    // A file where the state folder should be: the notes folder cannot be made.
    await writeFile(join(home, ".firstmate"), "in the way");

    await expect(deliver(NOTE)).resolves.toBe("sent");
    expect(threads.callsTo("sendShortened")).toEqual([]);
    expect(threads.callsTo("send")).toEqual([[mate.id, "watch output", "queue-if-active"]]);
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toMatch(/^Could not save the watch note, so it goes to the first mate in full: /);
  });

  it("waits when the stored first mate is gone", async () => {
    const { threads, store, deliver } = setup();
    const mate = threads.add({ status: "idle" });
    await store.setMateThreadId(mate.id);
    threads.archiveNow(mate.id);

    await expect(deliver(NOTE)).resolves.toBe("wait");
    expect(threads.callsTo("sendShortened")).toEqual([]);
  });

  it("waits when the stored id names no thread at all", async () => {
    const { threads, store, deliver } = setup();
    await store.setMateThreadId("thr_missing");

    await expect(deliver(NOTE)).resolves.toBe("wait");
    expect(threads.callsTo("sendShortened")).toEqual([]);
  });
});
