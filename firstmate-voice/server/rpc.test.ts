import { describe, expect, it } from "vitest";

import { sessionHandlers } from "./rpc";

const APP = { experimental_caller: { kind: "client" } } as never;
const PLUGIN = { experimental_caller: { kind: "plugin", pluginId: "not-allowed" } } as never;

function setup() {
  const calls: string[] = [];
  const sessions = {
    start: async (sdp: string, target: unknown) => {
      calls.push(`start ${sdp} ${JSON.stringify(target)}`); // a start looks up the subscription credential and takes over any live session
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
    debugPage: (afterSeq: number) => {
      calls.push(`debug ${afterSeq}`);
      return { sessionId: "fmv_1", startedAt: 1, entries: [], more: false, dropped: 0 };
    },
  };
  const crew = {
    mateThreadId: async () => {
      calls.push("mate");
      return "thr_mate";
    },
  };
  const hooks = {
    store: {
      all: async () => {
        calls.push("hooks");
        return { host_mine: "say hi" };
      },
      set: async (hostId: string, command: string) => {
        calls.push(`set ${hostId} ${command}`);
        return { [hostId]: command };
      },
    },
    hosts: async () => [{ id: "host_mine", name: "Studio" }],
  };
  return { calls, handlers: sessionHandlers(sessions as never, crew, hooks) };
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
    // The debug log holds transcripts and the instructions: only the owner's own app reads it.
    await expect(handlers["debug.log"]({ afterSeq: 0 }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    // The hooks are shell commands run on the owner's machines.
    await expect(handlers["hooks.list"]({}, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["hooks.set"]({ hostId: "host_mine", command: "rm -rf ~" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
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
    expect(await handlers["debug.log"]({ afterSeq: 3 }, APP)).toMatchObject({ sessionId: "fmv_1" });
    expect(await handlers["hooks.list"]({}, APP)).toEqual({ hooks: { host_mine: "say hi" } });
    expect(await handlers["hooks.set"]({ hostId: "host_mine", command: "say bye" }, APP)).toEqual({ hooks: { host_mine: "say bye" } });
    expect(calls).toEqual([
      'start v=0 offer {"hostId":null,"why":"a browser tab runs no hooks; bb\'s desktop app does"}',
      "mate",
      "debug 3",
      "hooks",
      "set host_mine say bye",
    ]);
  });

  it("run the hooks on the desktop window's own machine, and only on one of bb's", async () => {
    const { calls, handlers } = setup();
    await handlers["session.start"]({ sdp: "v=0 offer", hostId: "host_mine", client: "desktop" }, APP);
    await handlers["session.start"]({ sdp: "v=0 offer", hostId: "host_elsewhere", client: "desktop" }, APP);
    await handlers["session.start"]({ sdp: "v=0 offer", hostId: "host_mine", client: "mobile" }, APP);
    expect(calls).toEqual([
      'start v=0 offer {"hostId":"host_mine","name":"Studio"}',
      'start v=0 offer {"hostId":null,"why":"this window\'s machine (host_elsewhere) is not one of bb\'s active machines"}',
      'start v=0 offer {"hostId":null,"why":"bb\'s mobile app runs no hooks"}',
    ]);
  });
});
