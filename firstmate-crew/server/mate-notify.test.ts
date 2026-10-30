import { describe, expect, it } from "vitest";

import { MATE_LEVEL, MateNotifier } from "./mate-notify";
import { createStore } from "./store";
import { FakeNotifications, fakeLog, fakeThreads, memoryKv } from "./testing/fakes";

const MATE = "thr_mate";

function setup(options: { enabled?: boolean; mate?: string | null; delayMs?: number } = {}) {
  const notifications = new FakeNotifications();
  const threads = fakeThreads();
  threads.add({ id: MATE, title: "First mate" });
  const store = createStore(memoryKv());
  const log = fakeLog();
  const state = { enabled: options.enabled ?? true, now: 10_000 };
  const notifier = new MateNotifier({
    notifications,
    threads,
    store,
    enabled: async () => state.enabled,
    log,
    now: () => state.now,
    delayMs: options.delayMs ?? 0,
  });
  const ready = options.mate === null ? Promise.resolve() : store.setMateThreadId(options.mate ?? MATE);
  return { notifications, threads, store, log, state, notifier, ready };
}

describe("MateNotifier: the first mate's level", () => {
  it("leaves every level alone and asks bb nothing while the setting is off", async () => {
    const { notifications, store, notifier, ready } = setup({ enabled: false });
    await ready;
    await notifier.sync();
    expect(notifications.levelChanges).toEqual([]);
    expect(await store.notificationHold()).toBeNull();
    expect(notifier.notice()).toBeNull();
  });

  it("sets the first mate to questions, approvals and errors only, remembering its own level", async () => {
    const { notifications, store, notifier, ready } = setup();
    await ready;
    notifications.levels.set(MATE, "all");
    await notifier.sync();
    expect(notifications.levels.get(MATE)).toBe(MATE_LEVEL);
    expect(await store.notificationHold()).toEqual({ threadId: MATE, previous: "all" });

    // Syncing again changes nothing.
    await notifier.sync();
    expect(notifications.levelChanges).toEqual([{ threadId: MATE, level: MATE_LEVEL }]);
  });

  it("gives the level back when the setting goes off", async () => {
    const { notifications, store, state, notifier, ready } = setup();
    await ready;
    await notifier.sync();
    expect(notifications.levels.get(MATE)).toBe(MATE_LEVEL);

    state.enabled = false;
    await notifier.settingChanged();
    expect(notifications.levels.has(MATE)).toBe(false); // back to inherit
    expect(notifications.levelChanges.at(-1)).toEqual({ threadId: MATE, level: "inherit" });
    expect(await store.notificationHold()).toBeNull();
  });

  it("leaves a level the captain chose since FirstMate set it, and forgets the hold", async () => {
    const { notifications, store, state, notifier, ready } = setup();
    await ready;
    await notifier.sync();
    notifications.levels.set(MATE, "muted");

    state.enabled = false;
    await notifier.settingChanged();
    expect(notifications.levels.get(MATE)).toBe("muted");
    expect(await store.notificationHold()).toBeNull();
  });

  it("moves to a new first mate: the old one gets its level back, the new one is held", async () => {
    const { notifications, threads, store, notifier, ready } = setup();
    await ready;
    notifications.levels.set(MATE, "all");
    await notifier.sync();

    threads.add({ id: "thr_next" });
    notifications.levels.set("thr_next", "muted");
    await store.setMateThreadId("thr_next");
    await notifier.sync();
    expect(notifications.levels.get(MATE)).toBe("all");
    expect(notifications.levels.get("thr_next")).toBe(MATE_LEVEL);
    expect(await store.notificationHold()).toEqual({ threadId: "thr_next", previous: "muted" });
  });

  it("gives the level back when the first mate is released", async () => {
    const { notifications, store, notifier, ready } = setup();
    await ready;
    await notifier.sync();
    await store.setMateThreadId(null);
    await notifier.sync();
    expect(notifications.levels.has(MATE)).toBe(false);
    expect(await store.notificationHold()).toBeNull();
  });

  it("forgets the hold of a first mate bb no longer has", async () => {
    const { notifications, threads, store, notifier, ready } = setup();
    await ready;
    await notifier.sync();
    threads.archiveNow(MATE);
    await store.setMateThreadId(null);
    await notifier.sync();
    expect(await store.notificationHold()).toBeNull();
    expect(notifications.levelChanges).toEqual([{ threadId: MATE, level: MATE_LEVEL }]);
  });

  it("changes nothing on a bb that cannot send, says so on the board and logs it once", async () => {
    const { notifications, store, log, notifier, ready } = setup();
    await ready;
    notifications.available = false;
    await notifier.sync();
    await notifier.sync();
    expect(notifications.levelChanges).toEqual([]);
    expect(await store.notificationHold()).toBeNull();
    expect(notifier.notice()).toMatch(/bb 0\.48\.1 or later/u);
    expect(log.warnings).toHaveLength(1);

    notifications.available = true;
    await notifier.sync();
    expect(notifications.levels.get(MATE)).toBe(MATE_LEVEL);
    expect(notifier.notice()).toBeNull();
  });

  it("gives the level back when the push plugin goes away while held", async () => {
    const { notifications, store, notifier, ready } = setup();
    await ready;
    notifications.levels.set(MATE, "all");
    await notifier.sync();
    notifications.available = false;
    await notifier.sync();
    expect(notifications.levels.get(MATE)).toBe("all");
    expect(await store.notificationHold()).toBeNull();
  });

  it("keeps the hold when the level cannot be given back, and tries again on the next sync", async () => {
    const { notifications, store, state, log, notifier, ready } = setup();
    await ready;
    notifications.levels.set(MATE, "all");
    await notifier.sync();
    notifications.fail("setOwnLevel", new Error("plugin is off"));
    state.enabled = false;
    await notifier.settingChanged();
    expect(await store.notificationHold()).toEqual({ threadId: MATE, previous: "all" });
    expect(log.warnings.at(-1)).toMatch(/could not give thread thr_mate back its bb notification level \(all\): plugin is off/u);

    notifications.recover("setOwnLevel");
    await notifier.sync();
    expect(notifications.levels.get(MATE)).toBe("all");
    expect(await store.notificationHold()).toBeNull();
  });

  it("gives back what it changed when setting the level fails", async () => {
    const { notifications, store, notifier, ready } = setup();
    await ready;
    notifications.fail("setOwnLevel", new Error("refused"));
    await notifier.sync();
    expect(notifier.notice()).toMatch(/could not change the first mate's bb notification level \(refused\)/u);
    // The level never changed, so the hold is simply forgotten.
    notifications.recover("setOwnLevel");
    expect(await store.notificationHold()).toBeNull();
    expect(notifications.levels.has(MATE)).toBe(false);
  });
});

describe("MateNotifier: a finished turn", () => {
  it("sends one notification that opens the first mate, titled by the reply's first line", async () => {
    const { notifications, notifier, ready } = setup();
    await ready;
    await notifier.turnEnded(MATE, "PR ready for review, captain: https://github.com/you/web/pull/42\n\n(fix the flaky login test - risk: low)");
    expect(notifications.sent).toEqual([
      {
        title: "PR ready for review, captain: https://github.com/you/web/pull/42",
        body: "(fix the flaky login test - risk: low)",
        threadId: MATE,
      },
    ]);
  });

  it("skips the no-op reply and a turn with no text", async () => {
    const { notifications, notifier, ready } = setup();
    await ready;
    await notifier.turnEnded(MATE, "Captain, shipshape.");
    await notifier.turnEnded(MATE, " captain,  Shipshape! ");
    await notifier.turnEnded(MATE, null);
    expect(notifications.sent).toEqual([]);
    // The level is still FirstMate's: bb does not notify of those turns either.
    expect(notifications.levels.get(MATE)).toBe(MATE_LEVEL);
  });

  it("sends nothing for any thread but the first mate", async () => {
    const { notifications, threads, notifier, ready } = setup();
    await ready;
    threads.add({ id: "thr_crew", parentThreadId: MATE });
    await notifier.turnEnded("thr_crew", "Done.");
    expect(notifications.sent).toEqual([]);
    expect(notifications.levels.has("thr_crew")).toBe(false);
  });

  it("sends nothing while the setting is off: bb notifies as before", async () => {
    const { notifications, notifier, ready } = setup({ enabled: false });
    await ready;
    await notifier.turnEnded(MATE, "Done.");
    expect(notifications.sent).toEqual([]);
  });

  it("sends nothing when the captain read the turn before it went", async () => {
    const { notifications, notifier, ready, state } = setup();
    await ready;
    notifications.attentions.set(MATE, { lastReadAt: state.now + 500, latestAttentionAt: state.now });
    await notifier.turnEnded(MATE, "Done.");
    expect(notifications.sent).toEqual([]);

    notifications.attentions.set(MATE, { lastReadAt: state.now - 1, latestAttentionAt: state.now });
    await notifier.turnEnded(MATE, "Done.");
    expect(notifications.sent).toHaveLength(1);
  });

  it("sends nothing when the captain set another level in bb meanwhile, since bb then notifies itself", async () => {
    const { notifications, notifier, ready } = setup();
    await ready;
    await notifier.sync();
    notifications.levels.set(MATE, "all");
    await notifier.turnEnded(MATE, "Done.");
    expect(notifications.sent).toEqual([]);
  });

  it("sends only the later of two turns that end within the wait", async () => {
    const { notifications, notifier, ready } = setup({ delayMs: 50 });
    await ready;
    const first = notifier.turnEnded(MATE, "First.");
    const second = notifier.turnEnded(MATE, "Second.");
    await Promise.all([first, second]);
    expect(notifications.sent.map((sent) => sent.title)).toEqual(["Second."]);
  });

  it("does not let a no-op that ends within the wait drop the reply before it", async () => {
    const { notifications, notifier, ready } = setup({ delayMs: 50 });
    await ready;
    const first = notifier.turnEnded(MATE, "PR ready for review.");
    const second = notifier.turnEnded(MATE, "Captain, shipshape.");
    await Promise.all([first, second]);
    expect(notifications.sent.map((sent) => sent.title)).toEqual(["PR ready for review."]);
  });

  it("names threads the reply mentions", async () => {
    const { notifications, threads, notifier, ready } = setup();
    await ready;
    threads.add({ id: "thr_crew", title: "fix login", parentThreadId: MATE });
    await notifier.turnEnded(MATE, "Merged @thread:thr_crew#msg=3.");
    expect(notifications.sent[0]?.title).toBe("Merged “fix login”.");
  });

  it("gives the level back and stops sending when a send fails, until the setting is switched again", async () => {
    const { notifications, store, log, notifier, ready } = setup();
    await ready;
    notifications.levels.set(MATE, "all");
    notifications.fail("send", new Error("sender_stopped"));
    await notifier.turnEnded(MATE, "Done.");
    expect(notifications.levels.get(MATE)).toBe("all");
    expect(await store.notificationHold()).toBeNull();
    expect(notifier.notice()).toMatch(/stopped sending .* \(sender_stopped\)/u);
    expect(log.warnings).toHaveLength(1);

    // It stays off, so bb keeps notifying, however many turns end.
    notifications.recover("send");
    await notifier.turnEnded(MATE, "Done again.");
    expect(notifications.sent).toEqual([]);
    expect(notifications.levels.get(MATE)).toBe("all");

    await notifier.settingChanged();
    expect(notifier.notice()).toBeNull();
    await notifier.turnEnded(MATE, "Back.");
    expect(notifications.sent.map((sent) => sent.title)).toEqual(["Back."]);
  });

  it("treats a failed level read before sending as a failed send", async () => {
    const { notifications, notifier, ready } = setup();
    await ready;
    await notifier.sync();
    notifications.fail("attention", new Error("bb is down"));
    await notifier.turnEnded(MATE, "Done.");
    expect(notifier.notice()).toMatch(/bb is down/u);
    expect(notifications.levels.has(MATE)).toBe(false);
  });

  it("sends nothing once stopped, and leaves the level held for the next instance", async () => {
    const { notifications, store, notifier, ready } = setup();
    await ready;
    await notifier.sync();
    await notifier.stop();
    await notifier.turnEnded(MATE, "Done.");
    expect(notifications.sent).toEqual([]);
    expect(notifications.levels.get(MATE)).toBe(MATE_LEVEL);
    expect(await store.notificationHold()).toEqual({ threadId: MATE, previous: "inherit" });
  });
});
