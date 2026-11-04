/**
 * The workspace the app resolves file references against: on a card, in its settled row, in a thread's
 * view (the offer) and in a session's history, which falls back to the source thread once the session
 * thread's folder is gone.
 */
import { describe, expect, it } from "vitest";

import { LearningApi } from "./api";
import { OfferEngine } from "./offers";
import { SessionService } from "./sessions";
import { FakePorts, flush, thread } from "./testing/fake-ports";
import { memoryStore, settingsWith } from "./testing/store";
import { workspaceOf } from "./workspace";

const WORK = "thr_work";
const CALC = { environmentId: "env_1", rootPath: "/work/calc" };

function setup() {
  const ports = new FakePorts();
  ports.threads.set(WORK, thread({ id: WORK }));
  const store = memoryStore();
  const settings = () => settingsWith({});
  const offers = new OfferEngine({ ports, store, settings });
  const sessions = new SessionService(ports, store, settings);
  const api = new LearningApi({ ports, store, offers, sessions, settings });
  return { ports, store, sessions, api };
}

describe("workspaceOf", () => {
  it("is the thread's environment and its absolute folder", async () => {
    const { ports } = setup();
    expect(await workspaceOf(ports, WORK)).toEqual({ threadId: WORK, ...CALC });
  });

  it("is null for a gone thread, a thread with no environment, and an environment with no folder", async () => {
    const { ports } = setup();
    ports.threads.set("thr_none", thread({ id: "thr_none", environmentId: null }));
    ports.threads.set("thr_gone_env", thread({ id: "thr_gone_env", environmentId: "env_destroyed" }));
    ports.threads.set("thr_relative", thread({ id: "thr_relative", environmentId: "env_rel" }));
    ports.paths.set("env_rel", "work/calc");
    for (const id of ["thr_missing", "thr_none", "thr_gone_env", "thr_relative"]) expect(await workspaceOf(ports, id)).toBeNull();
  });
});

describe("where file references resolve", () => {
  it("a card carries the session thread's workspace, and its settled row keeps it", async () => {
    const { ports, sessions } = setup();
    const { threadId } = await sessions.start({ sourceThreadId: WORK, topic: "Retries", trigger: "manual", refs: {}, offerId: null });
    const reply = sessions.ask(threadId, { type: "trace", question: "Open `calc.py:12`.", files: ["calc.py:12"] }, "tool");
    await flush();
    const request = ports.cards[0]!.request;
    expect(request.payload).toMatchObject({ environmentId: "env_1", workspace: { threadId, ...CALC }, files: ["calc.py:12"] });
    expect(request.describe({ action: "skip" })).toMatchObject({ question: "Open `calc.py:12`.", workspace: { threadId, ...CALC } });
    ports.answer({ action: "skip" });
    await reply;
  });

  it("a thread's view carries its workspace, for the offer's paths", async () => {
    const { ports, api } = setup();
    expect((await api.threadView({ threadId: WORK })).workspace).toEqual({ threadId: WORK, ...CALC });
    ports.threads.set("thr_none", thread({ id: "thr_none", environmentId: null }));
    expect((await api.threadView({ threadId: "thr_none" })).workspace).toBeNull();
  });

  it("a session's history resolves in its thread's workspace, then the source thread's once that one is gone", async () => {
    const { ports, api, sessions } = setup();
    ports.threads.set("thr_child", thread({ id: "thr_child", environmentId: "env_child", parentThreadId: WORK }));
    ports.paths.set("env_child", "/work/child");
    const { sessionId, threadId } = await sessions.start({ sourceThreadId: "thr_child", topic: "Retries", trigger: "manual", refs: {}, offerId: null });
    expect((await api.sessionDetail({ sessionId })).workspace).toEqual({ threadId, environmentId: "env_child", rootPath: "/work/child" });
    // The fork is archived: its environment is destroyed, with no folder.
    ports.threads.set(threadId, { ...ports.threads.get(threadId)!, environmentId: "env_destroyed" });
    expect((await api.sessionDetail({ sessionId })).workspace).toEqual({ threadId: "thr_child", environmentId: "env_child", rootPath: "/work/child" });
    ports.paths.delete("env_child");
    expect((await api.sessionDetail({ sessionId })).workspace).toBeNull();
  });
});
