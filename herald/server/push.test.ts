/**
 * The takeover of bb's notification levels against a fake of bb's
 * push-notifications plugin that keeps levels the way it does: a thread's own
 * level, its ancestors, and the defaults. No real level is changed and no
 * notification is sent.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { BB_LEVEL_DEFAULTS, type LevelDefaults, type OwnLevel } from "../shared/push";
import type { ThreadChoice } from "../shared/thread-choice";
import type { PushPort, ThreadFacts } from "./ports";
import { PUSH_RECORD_PREFIX, PushTakeover, type PushSubject } from "./push";
import { recordingLog } from "./testing/fixtures";

interface FakeBb extends PushPort {
  own: Map<string, OwnLevel>;
  parents: Map<string, string>;
  sent: Array<{ title: string; body: string; threadId: string }>;
  setCalls: Array<{ threadId: string; level: OwnLevel }>;
  ancestorReads: number;
  unavailableReason: string | null;
  sendError: Error | null;
  defaultsValue: LevelDefaults;
}

function fakeBb(): FakeBb {
  const fake: FakeBb = {
    own: new Map(),
    parents: new Map(),
    sent: [],
    setCalls: [],
    ancestorReads: 0,
    unavailableReason: null,
    sendError: null,
    defaultsValue: BB_LEVEL_DEFAULTS,
    unavailable: async () => fake.unavailableReason,
    async ancestors(threadId) {
      fake.ancestorReads += 1;
      if (threadId === "gone") return null;
      const ids: string[] = [];
      for (let at = fake.parents.get(threadId); at !== undefined; at = fake.parents.get(at)) ids.push(at);
      return ids;
    },
    async ownLevels(threadIds) {
      const out = new Map<string, OwnLevel>();
      for (const id of threadIds) {
        const level = fake.own.get(id);
        if (level !== undefined && level !== "inherit") out.set(id, level);
      }
      return out;
    },
    async setOwnLevel(threadId, level) {
      fake.setCalls.push({ threadId, level });
      if (level === "inherit") fake.own.delete(threadId);
      else fake.own.set(threadId, level);
    },
    defaults: async () => fake.defaultsValue,
    async send(notification) {
      if (fake.sendError !== null) throw fake.sendError;
      fake.sent.push(notification);
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

  beforeEach(() => {
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

  describe("taking a thread over", () => {
    it("mutes bb for an announced thread, remembers its level, and sends the event bb no longer will", async () => {
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(true);
      expect(bb.own.get("t1")).toBe("muted");
      expect(kv.rows.get(`${PUSH_RECORD_PREFIX}t1`)).toEqual({ previous: "inherit" });
      // Later events: still Herald's to send.
      expect(await push.decide("t1", choice("announce"), "question")).toBe(true);
      expect(bb.setCalls).toEqual([{ threadId: "t1", level: "muted" }]);
    });

    it("mutes on a turn start, which sends nothing", async () => {
      expect(await push.decide("t1", choice("announce"), null)).toBe(false);
      expect(bb.own.get("t1")).toBe("muted");
    });

    it("leaves a Silent thread to bb", async () => {
      expect(await push.decide("t1", choice("silent"), "question")).toBe(false);
      expect(bb.setCalls).toEqual([]);
    });

    it("takes over a Questions-only thread, and sends what bb's level would have: finished turns at All", async () => {
      expect(await push.decide("t1", choice("questions"), "finished")).toBe(true);
      expect(await push.decide("t1", choice("questions"), "error")).toBe(true);
      expect(await push.decide("t1", choice("questions"), "permission")).toBe(true);
    });

    it("sends no finished turn for a thread bb notified only for input, but still its errors", async () => {
      bb.own.set("t1", "input-only");
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(false);
      expect(await push.decide("t1", choice("announce"), "error")).toBe(true);
      expect(kv.rows.get(`${PUSH_RECORD_PREFIX}t1`)).toEqual({ previous: "input-only" });
    });

    it("never takes over a thread already muted by a level Herald did not set — its own or an ancestor's", async () => {
      bb.own.set("t1", "muted");
      expect(await push.decide("t1", choice("announce"), "question")).toBe(false);
      bb.parents.set("t2", "root");
      bb.own.set("root", "muted");
      expect(await push.decide("t2", choice("announce"), "question")).toBe(false);
      bb.defaultsValue = { defaultLevel: "muted", childLevel: "inherit" };
      expect(await push.decide("t3", choice("announce"), "question")).toBe(false);
      expect(bb.setCalls).toEqual([]);
    });

    it("sends a worker's question when Herald's mute on its coordinator caps it, though the worker is Silent", async () => {
      bb.parents.set("worker", "t1");
      await push.decide("t1", choice("announce"), null);
      // A child thread notifies for input only by bb's default.
      expect(await push.decide("worker", choice("silent"), "question")).toBe(true);
      expect(await push.decide("worker", choice("silent"), "finished")).toBe(false);
      expect(bb.own.has("worker")).toBe(false);
    });

    it("changes nothing until the instance before it has given its threads back", async () => {
      const early = new PushTakeover({ port: bb, kv, enabled: async () => true, facts: async () => OPEN, interactionPending: async () => true, log });
      expect(await early.decide("t1", choice("announce"), "finished")).toBe(false);
      expect(bb.setCalls).toEqual([]);
    });

    it("reads nothing from bb when the switch is off and it holds no mute", async () => {
      enabled = false;
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(false);
      expect(bb.ancestorReads).toBe(0);
    });

    it("still sends a worker's question when giving its own level back fails", async () => {
      bb.parents.set("worker", "t1");
      await push.decide("t1", choice("announce"), null);
      await push.decide("worker", choice("announce"), null);
      bb.setOwnLevel = async () => {
        throw new Error("bb is away");
      };
      expect(await push.decide("worker", choice("silent"), "question")).toBe(true);
    });

    it("takes one decision at a time per thread", async () => {
      await Promise.all([push.decide("t1", choice("announce"), "finished"), push.decide("t1", choice("announce"), "question")]);
      expect(bb.setCalls).toEqual([{ threadId: "t1", level: "muted" }]);
    });
  });

  describe("giving a thread back", () => {
    it("restores the remembered level when the thread becomes Silent, and still sends that event", async () => {
      bb.own.set("t1", "input-only");
      await push.decide("t1", choice("announce"), null);
      expect(await push.decide("t1", choice("silent"), "question")).toBe(true);
      expect(bb.own.get("t1")).toBe("input-only");
      expect(kv.rows.size).toBe(0);
      expect(await push.decide("t1", choice("silent"), "question")).toBe(false);
    });

    it("restores every thread when the switch goes off", async () => {
      bb.own.set("t2", "all");
      await push.decide("t1", choice("announce"), null);
      await push.decide("t2", choice("announce"), null);
      enabled = false;
      await push.restoreAll();
      expect(bb.own.get("t1")).toBeUndefined();
      expect(bb.own.get("t2")).toBe("all");
      expect(kv.rows.size).toBe(0);
    });

    it("gives a muted thread back at its next event once the switch is off", async () => {
      await push.decide("t1", choice("announce"), null);
      enabled = false;
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(true);
      expect(bb.own.has("t1")).toBe(false);
    });

    it("does not overwrite a level someone else changed, and takes the thread over again from that level", async () => {
      await push.decide("t1", choice("announce"), null);
      bb.own.set("t1", "input-only");
      await push.restoreAll();
      expect(bb.own.get("t1")).toBe("input-only");
      expect(bb.setCalls).toEqual([{ threadId: "t1", level: "muted" }]);

      await push.decide("t1", choice("announce"), null);
      bb.own.set("t1", "all");
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(true);
      expect(kv.rows.get(`${PUSH_RECORD_PREFIX}t1`)).toEqual({ previous: "all" });
      expect(log.lines.some((line) => line.includes("changed outside Herald"))).toBe(true);
    });

    it("restores an archived thread and forgets a deleted one", async () => {
      await push.decide("t1", choice("announce"), null);
      await push.decide("t2", choice("announce"), null);
      await push.forget("t1", true);
      await push.forget("t2", false);
      expect(bb.own.has("t1")).toBe(false);
      expect(bb.own.get("t2")).toBe("muted");
      expect(kv.rows.size).toBe(0);
    });

    it("keeps the record when bb cannot be reached, for a later try", async () => {
      await push.decide("t1", choice("announce"), null);
      bb.setOwnLevel = async () => {
        throw new Error("push-notifications is not running");
      };
      await push.restoreAll();
      expect(kv.rows.has(`${PUSH_RECORD_PREFIX}t1`)).toBe(true);
    });
  });

  describe("when bb cannot send", () => {
    it("changes no level, and says why", async () => {
      bb.unavailableReason = "bb's Push notifications plugin is off.";
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(false);
      expect(bb.setCalls).toEqual([]);
      expect(await push.status()).toEqual({ state: "unavailable", message: "bb's Push notifications plugin is off. bb sends its own notifications." });
      expect(log.lines.filter((line) => line.includes("not available"))).toHaveLength(1);
    });

    it("gives every level back after a failed send, stops, and starts again when switched on", async () => {
      await push.decide("t1", choice("announce"), null);
      await push.decide("t2", choice("announce"), null);
      bb.sendError = new Error("Push notifications are not running");
      await push.send(subject(), "Login fix finished.");
      expect(bb.own.size).toBe(0);
      expect((await push.status()).state).toBe("failed");
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(false);
      expect(bb.own.size).toBe(0);

      bb.sendError = null;
      push.switchedOn();
      expect(await push.decide("t1", choice("announce"), "finished")).toBe(true);
      expect((await push.status()).state).toBe("on");
    });

    it("does not stop for a thread deleted before its notification went", async () => {
      await push.decide("t1", choice("announce"), null);
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
