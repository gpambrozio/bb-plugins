import { describe, expect, it, vi } from "vitest";

import type { FailingEntry } from "../shared/channels";
import { createFailurePush, type FailurePushDeps } from "./failure-push";

const backup: FailingEntry = { hostId: "mini", hostName: "Mac mini", id: "backup", name: "Backup", exitCode: 1 };
const sync: FailingEntry = { hostId: "laptop", hostName: "Laptop", id: "sync", name: "Sync notes", exitCode: 3 };

/** Plugin storage that outlives one instance, as `bb.storage.kv` outlives a reload. */
function storage(initial?: string[]) {
  return { value: initial };
}

function setup(options: { enabled?: boolean; store?: { value: string[] | undefined }; send?: FailurePushDeps["send"] } = {}) {
  const store = options.store ?? storage([]);
  const state = { enabled: options.enabled ?? true };
  const sent: { title: string; body: string }[] = [];
  const deps: FailurePushDeps = {
    enabled: async () => state.enabled,
    load: async () => store.value,
    save: async (keys) => {
      store.value = keys;
    },
    send:
      options.send ??
      (async (notification) => {
        sent.push(notification);
      }),
    warn: vi.fn(),
  };
  return { push: createFailurePush(deps), store, state, sent, deps };
}

describe("the push when a job starts failing", () => {
  it("sends one notification naming the job, its Mac and how it ended, when a job starts failing", async () => {
    const { push, sent } = setup();

    await push.observe([]);
    await push.observe([backup]);

    expect(sent).toEqual([{ title: "Backup failed on Mac mini", body: "Its last run exited with code 1." }]);
  });

  it("sends nothing more while the job stays failing", async () => {
    const { push, sent } = setup();

    await push.observe([backup]);
    await push.observe([backup]);
    await push.observe([{ ...backup, exitCode: 2 }]);

    expect(sent).toHaveLength(1);
  });

  it("notifies again when a job that recovered fails again", async () => {
    const { push, sent, store } = setup();

    await push.observe([backup]);
    await push.observe([]);
    expect(store.value).toEqual([]);
    await push.observe([backup]);

    expect(sent.map((notification) => notification.title)).toEqual(["Backup failed on Mac mini", "Backup failed on Mac mini"]);
  });

  it("tells each newly failing job apart, on each Mac", async () => {
    const { push, sent, store } = setup();

    await push.observe([backup]);
    await push.observe([backup, sync, { ...sync, hostId: "mini", hostName: "Mac mini" }]);

    expect(sent.map((notification) => notification.title)).toEqual([
      "Backup failed on Mac mini",
      "Sync notes failed on Laptop",
      "Sync notes failed on Mac mini",
    ]);
    expect(store.value).toEqual(["laptop/sync", "mini/backup", "mini/sync"]);
  });

  it("does not notify again after a reload for a job that was already failing", async () => {
    const store = storage([]);
    const before = setup({ store });
    await before.push.observe([backup]);
    before.push.dispose();

    const after = setup({ store });
    await after.push.observe([backup]);
    await after.push.observe([backup, sync]);

    expect(before.sent).toHaveLength(1);
    expect(after.sent.map((notification) => notification.title)).toEqual(["Sync notes failed on Laptop"]);
  });

  it("notifies after a reload for a job that recovered while the plugin was not loaded and failed again", async () => {
    const store = storage(["mini/backup"]);
    const { push, sent } = setup({ store });

    await push.observe([]);
    await push.observe([backup]);

    expect(sent).toHaveLength(1);
  });

  it("keeps the record of a Mac that did not answer, so a reload while it sleeps repeats nothing when it wakes", async () => {
    const store = storage([]);
    const before = setup({ store });
    await before.push.observe([backup, sync]);
    before.push.dispose();

    // After the reload the laptop is asleep: the new instance has no failures of its own to carry for it.
    const after = setup({ store });
    await after.push.observe([backup], ["laptop"]);
    expect(store.value).toEqual(["laptop/sync", "mini/backup"]);
    await after.push.observe([backup, sync]);

    expect(after.sent).toEqual([]);
  });

  it("only records the first count ever, so jobs already failing then do not notify", async () => {
    const { push, sent, store } = setup({ store: storage(undefined) });

    await push.observe([backup]);
    expect(sent).toEqual([]);
    expect(store.value).toEqual(["mini/backup"]);

    await push.observe([backup, sync]);
    expect(sent.map((notification) => notification.title)).toEqual(["Sync notes failed on Laptop"]);
  });

  it("sends nothing while the setting is off, and nothing for jobs already failing when it is turned on", async () => {
    const { push, sent, state } = setup({ enabled: false });

    await push.observe([]);
    await push.observe([backup]);
    expect(sent).toEqual([]);

    state.enabled = true;
    await push.observe([backup]);
    expect(sent).toEqual([]);

    await push.observe([backup, sync]);
    expect(sent.map((notification) => notification.title)).toEqual(["Sync notes failed on Laptop"]);
  });

  it("notifies after the setting is turned back on only for failures that started since", async () => {
    const { push, sent, state } = setup();

    await push.observe([backup]);
    state.enabled = false;
    await push.observe([]);
    await push.observe([sync]);
    state.enabled = true;
    await push.observe([sync]);
    await push.observe([sync, backup]);

    expect(sent.map((notification) => notification.title)).toEqual(["Backup failed on Mac mini", "Backup failed on Mac mini"]);
  });

  it("logs once and carries on when push notifications are not there", async () => {
    const send = vi.fn(async () => {
      throw new Error("plugin push-notifications is not enabled");
    });
    const { push, store, deps } = setup({ send });

    await push.observe([backup, sync]);
    await push.observe([]);
    await push.observe([backup]);

    expect(send).toHaveBeenCalledTimes(3);
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("plugin push-notifications is not enabled"));
    // The failure is still recorded, so it is not retried every minute.
    expect(store.value).toEqual(["mini/backup"]);
  });

  it("never rejects, even when storage fails", async () => {
    const { push, deps } = setup();
    deps.load = async () => {
      throw new Error("disk full");
    };

    await expect(push.observe([backup])).resolves.toBeUndefined();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("handles counts one at a time, so two close together send once", async () => {
    const { push, sent } = setup();

    await Promise.all([push.observe([backup]), push.observe([backup])]);

    expect(sent).toHaveLength(1);
  });

  it("sends and records nothing once disposed", async () => {
    const { push, sent, store } = setup();

    push.dispose();
    await push.observe([backup]);

    expect(sent).toEqual([]);
    expect(store.value).toEqual([]);
  });
});
