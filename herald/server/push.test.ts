/**
 * The takeover of bb's notification levels against a fake of bb's
 * push-notifications plugin that keeps levels the way it does — a thread's
 * own level, its ancestors, the defaults — and can run bb's two-second
 * coalescer, fail a call after it saved, or hold a call until released. No
 * real level is changed and no notification is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttentionReason } from "../shared/herald";
import { BB_LEVEL_DEFAULTS, levelAllows, resolveLevel, type LevelDefaults, type OwnLevel } from "../shared/push";
import type { ThreadChoice } from "../shared/thread-choice";
import type { PushPort, ThreadFacts } from "./ports";
import { OUTBOX_PREFIX, PUSH_RECORD_PREFIX, PushTakeover, RELEASE_QUIET_MS, RETRY_MS, SEND_RETRY_MS, type PushSubject } from "./push";
import { recordingLog } from "./testing/fixtures";

interface FakeBb extends PushPort {
  own: Map<string, OwnLevel>;
  parents: Map<string, string>;
  sent: Array<{ title: string; body: string; threadId: string }>;
  /** What bb's own coalescer sent, by `flushAfter`. */
  bbSent: Array<{ threadId: string; reason: AttentionReason }>;
  setCalls: Array<{ threadId: string; level: OwnLevel }>;
  ancestorReads: number;
  unavailableReason: string | null;
  sendError: Error | null;
  /** Set: the next level write saves and then fails, as bb's set can after its metadata write. */
  commitThenThrow: boolean;
  /** Set: every level write fails before saving. */
  setDown: boolean;
  /** Set: level reads fail this many times. */
  readFailures: number;
  /** Set: each level write waits for this before saving. */
  hold: Promise<void> | null;
  /** Set: each level read waits for this before answering. */
  readHold: Promise<void> | null;
  defaultsValue: LevelDefaults;
  /**
   * bb's own sender, in its order: two seconds after an event its flush
   * starts, reads the thread (taking `readMs`), then reads the level, which
   * decides.
   */
  flushAfter(threadId: string, reason: AttentionReason, readMs?: number): void;
}

function fakeBb(): FakeBb {
  const ancestorsOf = (threadId: string) => {
    const ids: string[] = [];
    for (let at = fake.parents.get(threadId); at !== undefined; at = fake.parents.get(at)) ids.push(at);
    return ids;
  };
  const fake: FakeBb = {
    own: new Map(),
    parents: new Map(),
    sent: [],
    bbSent: [],
    setCalls: [],
    ancestorReads: 0,
    unavailableReason: null,
    sendError: null,
    commitThenThrow: false,
    setDown: false,
    readFailures: 0,
    hold: null,
    readHold: null,
    defaultsValue: BB_LEVEL_DEFAULTS,
    unavailable: async () => fake.unavailableReason,
    async ancestors(threadId) {
      fake.ancestorReads += 1;
      if (threadId === "gone") return null;
      return ancestorsOf(threadId);
    },
    async descendants(threadId) {
      return [...fake.parents.keys()].filter((id) => ancestorsOf(id).includes(threadId));
    },
    async ownLevels(threadIds) {
      if (fake.readHold !== null) await fake.readHold;
      if (fake.readFailures > 0) {
        fake.readFailures -= 1;
        throw new Error("push-notifications is away");
      }
      const out = new Map<string, OwnLevel>();
      for (const id of threadIds) {
        const level = fake.own.get(id);
        if (level !== undefined && level !== "inherit") out.set(id, level);
      }
      return out;
    },
    async setOwnLevel(threadId, level) {
      if (fake.setDown) throw new Error("push-notifications is not running");
      if (fake.hold !== null) await fake.hold;
      fake.setCalls.push({ threadId, level });
      if (level === "inherit") fake.own.delete(threadId);
      else fake.own.set(threadId, level);
      if (fake.commitThenThrow) {
        fake.commitThenThrow = false;
        throw new Error("publishing the subtree failed");
      }
    },
    defaults: async () => fake.defaultsValue,
    async send(notification) {
      if (fake.sendError !== null) throw fake.sendError;
      fake.sent.push(notification);
    },
    flushAfter(threadId, reason, readMs = 0) {
      setTimeout(() => {
        setTimeout(() => {
          const level = resolveLevel(threadId, ancestorsOf(threadId), (id) => fake.own.get(id) ?? "inherit", fake.defaultsValue);
          if (levelAllows(level, reason)) fake.bbSent.push({ threadId, reason });
        }, readMs);
      }, 2_000);
    },
  };
  return fake;
}

function fakeKv() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    set: async (key: string, value: unknown) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
    list: async (prefix?: string) => [...rows.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)),
  };
}

const OPEN: ThreadFacts = { kind: "open", status: "idle", lastReadAt: 0, latestAttentionAt: 10 };

function subject(overrides: Partial<PushSubject> = {}): PushSubject {
  return {
    threadId: "t1",
    threadTitle: "Login fix",
    projectName: "Shop",
    reason: "finished",
    requestId: null,
    createdAt: new Date(5).toISOString(),
    ...overrides,
  };
}

describe("PushTakeover", () => {
  let bb: FakeBb;
  let kv: ReturnType<typeof fakeKv>;
  let enabled: boolean;
  let facts: ThreadFacts;
  let pending: boolean;
  let log: ReturnType<typeof recordingLog>;
  let push: PushTakeover;

  const choice = (value: ThreadChoice) => () => Promise.resolve(value);
  /** An event that arrives now, as the hooks hand it over: heard first, then decided. */
  const event = (threadId: string, reason: AttentionReason) => {
    const at = Date.now();
    push.saw(threadId, at);
    return { reason, at };
  };
  const decide = (threadId: string, value: ThreadChoice, reason: AttentionReason | null) =>
    push.decide(threadId, choice(value), reason === null ? null : event(threadId, reason));
  const held = (threadId: string) => {
    const row = kv.rows.get(`${PUSH_RECORD_PREFIX}${threadId}`) as { releasedAt?: number } | undefined;
    return row !== undefined && row.releasedAt === undefined;
  };
  /** Past every give-back's wait for quiet. */
  const quiet = () => vi.advanceTimersByTimeAsync(RELEASE_QUIET_MS + 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    bb = fakeBb();
    kv = fakeKv();
    enabled = true;
    facts = OPEN;
    pending = true;
    log = recordingLog();
    push = new PushTakeover({
      port: bb,
      kv,
      enabled: async () => enabled,
      facts: async () => facts,
      interactionPending: async () => pending,
      log,
    });
    push.setReady();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("taking a thread over", () => {
    it("mutes bb for an announced thread, remembers its level, and sends the event bb no longer will", async () => {
      expect(await decide("t1", "announce", "finished")).toBe(true);
      expect(bb.own.get("t1")).toBe("muted");
      expect(kv.rows.get(`${PUSH_RECORD_PREFIX}t1`)).toMatchObject({ previous: "inherit" });
      expect(await decide("t1", "announce", "question")).toBe(true);
      expect(bb.setCalls).toEqual([{ threadId: "t1", level: "muted" }]);
    });

    it("mutes on a turn start, which sends nothing", async () => {
      expect(await decide("t1", "announce", null)).toBe(false);
      expect(bb.own.get("t1")).toBe("muted");
    });

    it("leaves a Silent thread to bb", async () => {
      expect(await decide("t1", "silent", "question")).toBe(false);
      expect(bb.setCalls).toEqual([]);
    });

    it("takes over a Questions-only thread, and sends what bb's level would have: finished turns at All", async () => {
      expect(await decide("t1", "questions", "finished")).toBe(true);
      expect(await decide("t1", "questions", "error")).toBe(true);
      expect(await decide("t1", "questions", "permission")).toBe(true);
    });

    it("sends no finished turn for a thread bb notified only for input, but still its errors", async () => {
      bb.own.set("t1", "input-only");
      expect(await decide("t1", "announce", "finished")).toBe(false);
      expect(await decide("t1", "announce", "error")).toBe(true);
      expect(kv.rows.get(`${PUSH_RECORD_PREFIX}t1`)).toMatchObject({ previous: "input-only" });
    });

    it("never takes over a thread already muted by a level Herald did not set — its own or an ancestor's", async () => {
      bb.own.set("t1", "muted");
      expect(await decide("t1", "announce", "question")).toBe(false);
      bb.parents.set("t2", "root");
      bb.own.set("root", "muted");
      expect(await decide("t2", "announce", "question")).toBe(false);
      bb.defaultsValue = { defaultLevel: "muted", childLevel: "inherit" };
      expect(await decide("t3", "announce", "question")).toBe(false);
      expect(bb.setCalls).toEqual([]);
    });

    it("sends a worker's question when Herald's mute on its coordinator caps it, though the worker is Silent", async () => {
      bb.parents.set("worker", "t1");
      await decide("t1", "announce", null);
      expect(await decide("worker", "silent", "question")).toBe(true);
      expect(await decide("worker", "silent", "finished")).toBe(false);
      expect(bb.own.has("worker")).toBe(false);
    });

    it("still sends an event whose mute was set long after it: bb may still be reading (a rare duplicate, never a loss)", async () => {
      const early = { reason: "finished" as const, at: Date.now() - 10_000 };
      push.saw("t1", early.at);
      expect(await push.decide("t1", choice("announce"), early)).toBe(true);
      expect(bb.own.get("t1")).toBe("muted");
    });

    it("changes nothing until the instance before it has given its threads back", async () => {
      const early = new PushTakeover({ port: bb, kv, enabled: async () => true, facts: async () => OPEN, interactionPending: async () => true, log });
      expect(await early.decide("t1", choice("announce"), { reason: "finished", at: Date.now() })).toBe(false);
      expect(bb.setCalls).toEqual([]);
    });

    it("reads nothing from bb when the switch is off and it holds no record", async () => {
      enabled = false;
      expect(await decide("t1", "announce", "finished")).toBe(false);
      expect(bb.ancestorReads).toBe(0);
    });

    it("takes one decision at a time", async () => {
      await Promise.all([decide("t1", "announce", "finished"), decide("t1", "announce", "question")]);
      expect(bb.setCalls).toEqual([{ threadId: "t1", level: "muted" }]);
    });
  });

  describe("giving a thread back", () => {
    it("waits for quiet before giving a Silent thread back, still sending what comes meanwhile", async () => {
      bb.own.set("t1", "input-only");
      await decide("t1", "announce", null);
      expect(await decide("t1", "silent", "question")).toBe(true);
      // Still muted: bb's flush for that question must read the mute.
      expect(bb.own.get("t1")).toBe("muted");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await decide("t1", "silent", "error")).toBe(true);
      await quiet();
      expect(bb.own.get("t1")).toBe("input-only");
      expect(held("t1")).toBe(false);
      expect(await decide("t1", "silent", "question")).toBe(false);
    });

    it("gives every thread back once quiet when the switch goes off", async () => {
      bb.own.set("t2", "all");
      await decide("t1", "announce", null);
      await decide("t2", "announce", null);
      enabled = false;
      await push.switchedOff();
      await quiet();
      expect(bb.own.get("t1")).toBeUndefined();
      expect(bb.own.get("t2")).toBe("all");
      expect(held("t1") || held("t2")).toBe(false);
    });

    it("keeps a thread taken over when the switch goes on again before the give-back", async () => {
      await decide("t1", "announce", null);
      event("t1", "finished");
      enabled = false;
      await push.switchedOff();
      enabled = true;
      push.switchedOn();
      await quiet();
      expect(bb.own.get("t1")).toBe("muted");
    });

    it("does not overwrite a level someone else changed, and takes the thread over again from that level", async () => {
      await decide("t1", "announce", null);
      bb.own.set("t1", "input-only");
      enabled = false;
      await push.switchedOff();
      await quiet();
      expect(bb.own.get("t1")).toBe("input-only");
      expect(bb.setCalls).toEqual([{ threadId: "t1", level: "muted" }]);

      enabled = true;
      push.switchedOn();
      await decide("t1", "announce", null);
      bb.own.set("t1", "all");
      await decide("t1", "announce", null);
      expect(kv.rows.get(`${PUSH_RECORD_PREFIX}t1`)).toMatchObject({ previous: "all" });
      expect(log.lines.some((line) => line.includes("no longer the mute Herald set"))).toBe(true);
    });

    it("cannot tell a mute someone else set on a thread it holds from its own, and gives it back (a documented limit)", async () => {
      await decide("t1", "announce", null);
      // Another writer sets Muted again: bb keeps no owner, the level reads the same.
      bb.own.set("t1", "muted");
      enabled = false;
      await push.switchedOff();
      await quiet();
      expect(bb.own.has("t1")).toBe(false);
    });

    it("keeps the mute when a thread set to Silent is set back to Announce before its give-back", async () => {
      await decide("t1", "announce", null);
      await decide("t1", "silent", "question");
      await vi.advanceTimersByTimeAsync(500);
      await decide("t1", "announce", null);
      await vi.advanceTimersByTimeAsync(RELEASE_QUIET_MS * 2);
      expect(bb.own.get("t1")).toBe("muted");
      expect(held("t1")).toBe(true);
    });

    it("leaves a mute set after its give-back finished alone — the README's order for muting a thread in bb", async () => {
      await decide("t1", "announce", null);
      await decide("t1", "silent", null);
      await quiet();
      // Confirmed back, as `bb push-notifications thread` shows it; then muted by hand.
      expect(bb.own.has("t1")).toBe(false);
      bb.own.set("t1", "muted");
      enabled = false;
      await push.switchedOff();
      await quiet();
      await decide("t1", "silent", "question");
      expect(bb.own.get("t1")).toBe("muted");
    });

    it("gives an archived thread back and forgets a deleted one", async () => {
      await decide("t1", "announce", null);
      await decide("t2", "announce", null);
      await push.forget("t1", true);
      await push.forget("t2", false);
      await quiet();
      expect(bb.own.has("t1")).toBe(false);
      expect(bb.own.get("t2")).toBe("muted");
      expect(kv.rows.has(`${PUSH_RECORD_PREFIX}t2`)).toBe(false);
    });
  });

  describe("when a call fails or overlaps", () => {
    it("keeps its record when a mute fails after bb saved it, sends the event, and gives the level back later", async () => {
      bb.commitThenThrow = true;
      expect(await decide("t1", "announce", "question")).toBe(true);
      expect(bb.own.get("t1")).toBe("muted");
      expect(held("t1")).toBe(true);
      expect(await decide("t1", "announce", "finished")).toBe(true);
      enabled = false;
      await push.switchedOff();
      await quiet();
      expect(bb.own.has("t1")).toBe(false);
    });

    it("drops its claim when a mute that failed never landed", async () => {
      bb.setDown = true;
      expect(await decide("t1", "announce", "question")).toBe(true);
      bb.setDown = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await decide("t1", "silent", "question");
      expect(held("t1")).toBe(false);
      expect(bb.own.has("t1")).toBe(false);
    });

    it("treats a give-back that failed after bb saved it as done at the next read, without writing again", async () => {
      await decide("t1", "announce", null);
      bb.commitThenThrow = true;
      enabled = false;
      await push.switchedOff();
      await quiet();
      expect(bb.own.has("t1")).toBe(false);
      expect(held("t1")).toBe(true);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(held("t1")).toBe(false);
      expect(bb.setCalls).toEqual([
        { threadId: "t1", level: "muted" },
        { threadId: "t1", level: "inherit" },
      ]);
    });

    it("leaves nothing muted when the switch goes off while a takeover waits on bb", async () => {
      let release: () => void = () => {};
      bb.hold = new Promise((resolve) => (release = resolve));
      const deciding = decide("t1", "announce", null);
      await vi.advanceTimersByTimeAsync(0);
      enabled = false;
      const off = push.switchedOff();
      release();
      bb.hold = null;
      await deciding;
      await off;
      await quiet();
      expect(bb.own.has("t1")).toBe(false);
      expect(held("t1")).toBe(false);
    });

    it("does not commit a takeover whose choice was still being read when the switch went off", async () => {
      let answer: (value: ThreadChoice) => void = () => {};
      const deciding = push.decide("t1", () => new Promise<ThreadChoice>((resolve) => (answer = resolve)), null);
      await vi.advanceTimersByTimeAsync(0);
      enabled = false;
      const off = push.switchedOff();
      answer("announce");
      await deciding;
      await off;
      await quiet();
      expect(bb.setCalls).toEqual([]);
    });

    it("leaves nothing muted when Herald unloads while a takeover waits on bb", async () => {
      let release: () => void = () => {};
      bb.hold = new Promise((resolve) => (release = resolve));
      const deciding = decide("t1", "announce", null);
      await vi.advanceTimersByTimeAsync(0);
      const closing = push.close();
      release();
      bb.hold = null;
      await deciding;
      await vi.advanceTimersByTimeAsync(RELEASE_QUIET_MS + 1);
      await closing;
      expect(bb.own.has("t1")).toBe(false);
      expect(await decide("t2", "announce", null)).toBe(false);
      expect(bb.own.has("t2")).toBe(false);
    });

    it("sends a Silent worker's question when bb cannot be read, because Herald holds its coordinator's mute", async () => {
      bb.parents.set("worker", "t1");
      await decide("t1", "announce", null);
      bb.readFailures = 1;
      expect(await decide("worker", "silent", "question")).toBe(true);
    });

    it("keeps notifying for a coordinator it could not give back, and gives it back once bb is there again", async () => {
      bb.parents.set("worker", "t1");
      await decide("t1", "announce", null);
      enabled = false;
      bb.setDown = true;
      await push.switchedOff();
      await quiet();
      expect(bb.own.get("t1")).toBe("muted");
      // Off, but the coordinator is still Herald's mute: the worker's question is Herald's to send.
      expect(await decide("worker", "silent", "question")).toBe(true);
      expect((await push.status()).message).toContain("1 thread is still muted in bb by Herald");
      bb.setDown = false;
      await vi.advanceTimersByTimeAsync(RETRY_MS + RELEASE_QUIET_MS + 1);
      expect(bb.own.has("t1")).toBe(false);
      expect((await push.status()).message).toBeNull();
    });
  });

  describe("with bb's own sender running", () => {
    it("sends a question once when the switch goes off before bb's flush: bb reads the mute, Herald sends", async () => {
      await decide("t1", "announce", null);
      await vi.advanceTimersByTimeAsync(RELEASE_QUIET_MS + 1);
      const question = event("t1", "question");
      bb.flushAfter("t1", "question");
      const owes = await push.decide("t1", choice("announce"), question);
      await vi.advanceTimersByTimeAsync(500);
      enabled = false;
      await push.switchedOff();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(owes).toBe(true);
      expect(bb.bbSent).toEqual([]);
      expect(bb.own.has("t1")).toBe(false);
      // After the give-back, bb sends and Herald does not.
      const later = event("t1", "question");
      bb.flushAfter("t1", "question");
      expect(await push.decide("t1", choice("announce"), later)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(bb.bbSent).toEqual([{ threadId: "t1", reason: "question" }]);
    });

    it("sends a question whose mute landed while bb's slow flush was still reading", async () => {
      // The question arrives before any takeover; bb starts its flush at 2 s and reads the level at 4 s.
      const question = event("t1", "question");
      bb.flushAfter("t1", "question", 2_000);
      await vi.advanceTimersByTimeAsync(3_000);
      // Herald's lookups were slow: the decision, and the mute, come at 3 s.
      expect(await push.decide("t1", choice("announce"), question)).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(bb.bbSent).toEqual([]);
    });

    it("waits again when a thread below has an event while the give-back reads bb", async () => {
      bb.parents.set("worker", "t1");
      await decide("t1", "announce", null);
      let release: () => void = () => {};
      bb.readHold = new Promise((resolve) => (release = resolve));
      enabled = false;
      void push.switchedOff();
      await vi.advanceTimersByTimeAsync(10);
      // The give-back is reading the coordinator's level when the worker asks.
      const question = event("worker", "question");
      bb.flushAfter("worker", "question", 500);
      bb.readHold = null;
      release();
      const owes = await push.decide("worker", choice("silent"), question);
      await vi.advanceTimersByTimeAsync(2_600);
      expect(owes).toBe(true);
      expect(bb.bbSent).toEqual([]);
      expect(bb.own.get("t1")).toBe("muted");
      await quiet();
      expect(bb.own.has("t1")).toBe(false);
    });

    it("sends a worker's question decided after its coordinator was given back and taken over again", async () => {
      bb.parents.set("worker", "t1");
      await decide("t1", "announce", null);
      const question = event("worker", "question");
      bb.flushAfter("worker", "question");
      enabled = false;
      await push.switchedOff();
      await vi.advanceTimersByTimeAsync(RELEASE_QUIET_MS + 1);
      expect(bb.own.has("t1")).toBe(false);
      enabled = true;
      push.switchedOn();
      await decide("t1", "announce", null);
      await vi.advanceTimersByTimeAsync(1_000);
      // The worker's lookups took five seconds.
      expect(await push.decide("worker", choice("silent"), question)).toBe(true);
      expect(bb.bbSent).toEqual([]);
    });

    it("still owes an event decided after a give-back that came after bb's flush", async () => {
      await decide("t1", "announce", null);
      const question = event("t1", "question");
      bb.flushAfter("t1", "question");
      enabled = false;
      await push.switchedOff();
      await vi.advanceTimersByTimeAsync(RELEASE_QUIET_MS + 1);
      expect(bb.own.has("t1")).toBe(false);
      // Decided late — the lookups were slow — but bb's flush read the mute.
      expect(await push.decide("t1", choice("announce"), question)).toBe(true);
      expect(bb.bbSent).toEqual([]);
    });
  });

  describe("when bb cannot send", () => {
    it("changes no level, and says why", async () => {
      bb.unavailableReason = "bb's Push notifications plugin is off.";
      expect(await decide("t1", "announce", "finished")).toBe(false);
      expect(bb.setCalls).toEqual([]);
      expect(await push.status()).toEqual({ state: "unavailable", message: "bb's Push notifications plugin is off. bb sends its own notifications." });
      expect(log.lines.filter((line) => line.includes("not available"))).toHaveLength(1);
    });

    it("tries a failed send again and delivers it, sends what else is owed, and gives the levels back", async () => {
      await decide("t1", "announce", null);
      await decide("t2", "announce", null);
      bb.sendError = new Error("Push notifications are not running");
      await push.send(subject(), "Login fix finished.");
      expect((await push.status()).state).toBe("failed");
      expect(bb.sent).toEqual([]);
      bb.sendError = null;
      // Another event bb held back while muted is still sent, failure or not.
      await push.send(subject({ threadId: "t2" }), "Docs finished.");
      await vi.advanceTimersByTimeAsync(SEND_RETRY_MS[0] + RELEASE_QUIET_MS);
      expect(bb.sent.map((sent) => sent.threadId).sort()).toEqual(["t1", "t2"]);
      expect(bb.own.size).toBe(0);
      // No new takeover until switched on again.
      expect(await decide("t3", "announce", "finished")).toBe(false);
      push.switchedOn();
      expect(await decide("t3", "announce", "finished")).toBe(true);
    });

    it("keeps a failed send across a reload, and the next instance sends it once bb is back", async () => {
      await decide("t1", "announce", null);
      bb.sendError = new Error("Push notifications are not running");
      await push.send(subject(), "Login fix finished.");
      expect([...kv.rows.keys()].some((key) => key.startsWith(OUTBOX_PREFIX))).toBe(true);
      await push.close();
      const next = new PushTakeover({ port: bb, kv, enabled: async () => true, facts: async () => facts, interactionPending: async () => true, log });
      await next.setReady();
      bb.sendError = null;
      await vi.advanceTimersByTimeAsync(SEND_RETRY_MS[0]);
      expect(bb.sent.map((sent) => sent.body)).toEqual(["Login fix finished."]);
      expect([...kv.rows.keys()].some((key) => key.startsWith(OUTBOX_PREFIX))).toBe(false);
      await next.close();
    });

    it("gives up a send after its last try, with an error", async () => {
      bb.sendError = new Error("relay down");
      await push.send(subject(), "Login fix finished.");
      for (const delay of SEND_RETRY_MS) await vi.advanceTimersByTimeAsync(delay);
      expect(bb.sent).toEqual([]);
      expect(log.lines.some((line) => line.includes("Gave up on the notification for t1"))).toBe(true);
    });

    it("does not stop for a thread deleted before its notification went", async () => {
      await decide("t1", "announce", null);
      bb.sendError = new Error("Thread not found: t1");
      await push.send(subject(), "Login fix finished.");
      expect((await push.status()).state).toBe("on");
      expect(bb.own.get("t1")).toBe("muted");
    });

    it("says off while the switch is off", async () => {
      enabled = false;
      expect(await push.status()).toEqual({ state: "off", message: null });
    });
  });

  describe("sending", () => {
    it("titles it with the thread and project, carries the sentence, and opens the thread it is about", async () => {
      await push.send(subject({ threadId: "worker" }), "Login fix finished. I fixed auth.ts.");
      expect(bb.sent).toEqual([{ title: "Login fix · Shop", body: "Login fix finished. I fixed auth.ts.", threadId: "worker" }]);
    });

    it("cuts a long sentence to what bb sends, at a word", async () => {
      await push.send(subject(), `${"word ".repeat(60)}end`);
      const [sent] = bb.sent;
      expect(sent?.body.length).toBeLessThanOrEqual(180);
      expect(sent?.body.endsWith("word…")).toBe(true);
    });

    it("skips what is no longer news, as bb would", async () => {
      facts = { ...OPEN, lastReadAt: 20 };
      await push.send(subject(), "read already");
      facts = { ...OPEN, status: "active" };
      await push.send(subject(), "running again");
      facts = OPEN;
      await push.send(subject({ reason: "error" }), "not failed");
      pending = false;
      await push.send(subject({ reason: "question", requestId: "i1" }), "answered");
      facts = { kind: "gone" };
      await push.send(subject(), "archived");
      expect(bb.sent).toEqual([]);
    });

    it("sends a failed turn and a waiting question", async () => {
      facts = { ...OPEN, status: "error" };
      await push.send(subject({ reason: "error" }), "Login fix stopped with an error.");
      facts = { ...OPEN, status: "active" };
      await push.send(subject({ reason: "question", requestId: "i1" }), "Login fix has a question: Which DB?");
      expect(bb.sent.map((sent) => sent.body)).toEqual(["Login fix stopped with an error.", "Login fix has a question: Which DB?"]);
    });
  });
});
