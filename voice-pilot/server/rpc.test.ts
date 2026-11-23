import { describe, expect, it } from "vitest";

import { SETTINGS, rpcContract } from "../server";
import { hostContract } from "../shared/host-contract";
import { sessionHandlers } from "./rpc";

const APP = { experimental_caller: { kind: "client" } } as never;
const PLUGIN = { experimental_caller: { kind: "plugin", pluginId: "not-allowed" } } as never;

function setup() {
  const calls: string[] = [];
  const sessions = {
    start: async (sdp: string, target: unknown, threadId: string | null) => {
      calls.push(`start ${sdp} ${JSON.stringify(target)} ${threadId}`);
      return { sessionId: "vp_1", answerSdp: "answer" };
    },
    renewed: async () => void calls.push("renewed"),
    renew: async () => {
      calls.push("renew");
      return { answerSdp: "answer" };
    },
    end: async () => void calls.push("end"),
    alive: (_id: string, threadId?: string | null) => {
      calls.push(`alive ${threadId}`);
      return true;
    },
    focus: (_id: string, threadId: string | null) => void calls.push(`focus ${threadId}`),
    current: () => {
      calls.push("current");
      return null;
    },
    debugPage: (afterSeq: number) => {
      calls.push(`debug ${afterSeq}`);
      return { sessionId: "vp_1", startedAt: 1, entries: [], more: false, dropped: 0 };
    },
  };
  const hooks = {
    hosts: async () => [{ id: "host_mine", name: "Studio" }],
    statuses: async (hosts: Array<{ id: string; name: string }>) => {
      calls.push(`hook status ${hosts.map((host) => host.id).join(",")}`);
      return hosts.map((host) => ({ hostId: host.id, name: host.name, status: { present: true, executable: true } }));
    },
  };
  return { calls, handlers: sessionHandlers(sessions as never, hooks) };
}

describe("the session RPCs", () => {
  it("refuse another plugin before anything runs: no credential lookup, no takeover", async () => {
    const { calls, handlers } = setup();
    await expect(handlers["session.start"]({ sdp: "v=0 offer from elsewhere" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.renew"]({ sessionId: "vp_1", sdp: "v=0 offer" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.renewed"]({ sessionId: "vp_1" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.end"]({ sessionId: "vp_1", reason: "x" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.alive"]({ sessionId: "vp_1" }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.focus"]({ sessionId: "vp_1", threadId: null }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["session.current"]({}, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["debug.log"]({ afterSeq: 0 }, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["hooks.status"]({}, PLUGIN)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
  });

  it("refuse a call that names no caller", async () => {
    const { calls, handlers } = setup();
    await expect(handlers["session.start"]({ sdp: "v=0 offer" }, undefined as never)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
  });

  it("serve bb's app, with the thread on its screen", async () => {
    const { calls, handlers } = setup();
    expect(await handlers["session.start"]({ sdp: "v=0 offer", threadId: "thr_a" }, APP)).toEqual({ sessionId: "vp_1", answerSdp: "answer" });
    expect(await handlers["session.alive"]({ sessionId: "vp_1", threadId: "thr_b" }, APP)).toEqual({ live: true });
    expect(await handlers["session.focus"]({ sessionId: "vp_1", threadId: null }, APP)).toBeNull();
    expect(await handlers["debug.log"]({ afterSeq: 3 }, APP)).toMatchObject({ sessionId: "vp_1" });
    expect(await handlers["hooks.status"]({}, APP)).toEqual({ machines: [{ hostId: "host_mine", name: "Studio", status: { present: true, executable: true } }] });
    expect(calls).toEqual([
      'start v=0 offer {"hostId":null,"why":"a browser tab runs no hooks; bb\'s desktop app does"} thr_a',
      "alive thr_b",
      "focus null",
      "debug 3",
      "hook status host_mine",
    ]);
  });

  it("run the hooks on the desktop window's own machine, and only on one of bb's", async () => {
    const { calls, handlers } = setup();
    await handlers["session.start"]({ sdp: "v=0 offer", hostId: "host_mine", client: "desktop" }, APP);
    await handlers["session.start"]({ sdp: "v=0 offer", hostId: "host_elsewhere", client: "desktop" }, APP);
    await handlers["session.start"]({ sdp: "v=0 offer", hostId: "host_mine", client: "mobile" }, APP);
    expect(calls).toEqual([
      'start v=0 offer {"hostId":"host_mine","name":"Studio"} null',
      'start v=0 offer {"hostId":null,"why":"this window\'s machine (host_elsewhere) is not one of bb\'s active machines"} null',
      'start v=0 offer {"hostId":null,"why":"bb\'s mobile app runs no hooks"} null',
    ]);
  });
});

/** Every key an object schema (or one nested in it) accepts. */
function inputKeys(schema: unknown): string[] {
  const def = (schema as { def?: { type?: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown; options?: unknown[] } }).def;
  if (def === undefined) return [];
  if (def.type === "object" && def.shape !== undefined) return Object.entries(def.shape).flatMap(([key, value]) => [key, ...inputKeys(value)]);
  if (def.innerType !== undefined) return inputKeys(def.innerType);
  if (def.element !== undefined) return inputKeys(def.element);
  return (def.options ?? []).flatMap(inputKeys);
}

describe("the voice hooks' command", () => {
  // bb names its command line a client too, so anything an RPC or a setting could set, an agent could.
  it("cannot be set, read or named through any RPC or setting: each machine runs its own file", () => {
    const methods = Object.keys(rpcContract);
    expect(methods.filter((method) => method.startsWith("hooks."))).toEqual(["hooks.status"]);
    expect(methods.some((method) => /set|save|write|update/iu.test(method))).toBe(false);
    for (const [method, { input }] of Object.entries(rpcContract)) {
      expect(inputKeys(input).filter((key) => /command|script|path|file|hook/iu.test(key)), method).toEqual([]);
    }
    expect(Object.keys(SETTINGS).filter((key) => /hook|command|script/iu.test(key))).toEqual([]);
  });

  it("is never sent to a machine either: the host calls take only the moment and the reason", () => {
    expect(inputKeys(hostContract.status.input)).toEqual([]);
    expect(inputKeys(hostContract.run.input)).toEqual(["event", "reason"]);
    expect(() => hostContract.run.input.parse({ event: "listening-started", reason: null, command: "touch /tmp/x" })).toThrow();
  });
});

describe("the settings", () => {
  it("keep the API key a secret and the instructions editable, greeting included", () => {
    expect(SETTINGS.openaiApiKey).toMatchObject({ type: "string", secret: true });
    expect(SETTINGS.model.default).toBe("gpt-realtime-2.1");
    expect(SETTINGS.instructions).toMatchObject({ type: "string", experimental_multiline: true });
    expect(SETTINGS.instructions.default).toContain("Greeting:");
  });
});
