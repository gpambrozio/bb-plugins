import { describe, expect, it } from "vitest";

import { sessionHandlers } from "./rpc";

const APP = { experimental_caller: { kind: "client" } } as never;
const PLUGIN = { experimental_caller: { kind: "plugin", pluginId: "not-allowed" } } as never;

function setup() {
  const calls: string[] = [];
  const sessions = {
    start: async (sdp: string) => {
      calls.push(`start ${sdp}`); // a start looks up the subscription credential and takes over any live session
      return { sessionId: "fmv_1", answerSdp: "answer" };
    },
    renewed: async () => {
      calls.push("renewed");
    },
    renew: async () => {
      calls.push("renew");
      return { answerSdp: "answer" };
    },
    end: async () => {
      calls.push("end");
    },
    alive: () => {
      calls.push("alive");
      return true;
    },
    current: () => {
      calls.push("current");
      return null;
    },
  };
  const crew = {
    mateThreadId: async () => {
      calls.push("mate");
      return "thr_mate";
    },
  };
  return { calls, handlers: sessionHandlers(sessions as never, crew) };
}

describe("the session RPCs", () => {
  it("refuse another plugin before anything runs: no credential lookup, no takeover", async () => {
    const { calls, handlers } = setup();
    await expect(handlers["session.start"]({ sdp: "v=0 offer from elsewhere" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.renew"]({ sessionId: "fmv_1", sdp: "v=0 offer" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.renewed"]({ sessionId: "fmv_1" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.end"]({ sessionId: "fmv_1", reason: "x" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.alive"]({ sessionId: "fmv_1" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.current"]({}, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["mate.thread"]({}, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
  });

  it("refuse a call that names no caller", async () => {
    const { calls, handlers } = setup();
    await expect(handlers["session.start"]({ sdp: "v=0 offer" }, undefined as never)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
  });

  it("serve bb's app", async () => {
    const { calls, handlers } = setup();
    expect(await handlers["session.start"]({ sdp: "v=0 offer" }, APP)).toEqual({ sessionId: "fmv_1", answerSdp: "answer" });
    expect(await handlers["mate.thread"]({}, APP)).toEqual({ threadId: "thr_mate" });
    expect(calls).toEqual(["start v=0 offer", "mate"]);
  });
});
