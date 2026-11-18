import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const legs: FakeLeg[] = [];

class FakeLeg {
  offer = `v=0 offer ${legs.length + 1}`;
  closed = false;
  fail: Error | null = null;
  async accept(): Promise<void> {
    if (this.fail !== null) throw this.fail;
  }
  async connected(): Promise<void> {
    if (this.fail !== null) throw this.fail;
  }
  close(): void {
    this.closed = true;
  }
}

vi.mock("./webrtc", () => ({
  openLeg: async () => {
    const leg = new FakeLeg();
    legs.push(leg);
    return leg;
  },
}));
vi.mock("./platform", () => ({ voicePlatform: () => "desktop" }));

const { VoiceController } = await import("./controller");

class FakeTrack {
  stopped = false;
  enabled = true;
  stop(): void {
    this.stopped = true;
  }
}

function fakeStream() {
  const track = new FakeTrack();
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}

/** A microphone permission prompt the test answers when it likes. */
function pendingMicrophone() {
  const asks: { resolve: (stream: MediaStream) => void }[] = [];
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: () => new Promise<MediaStream>((resolve) => asks.push({ resolve })) },
  });
  return asks;
}

function fakeRpc() {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  let sessions = 0;
  const renewFails = { value: false };
  const rpc = {
    call: async (method: string, input: Record<string, unknown>) => {
      calls.push({ method, input });
      if (method === "session.start") {
        sessions += 1;
        return { sessionId: `fmv_${sessions}`, answerSdp: "answer" };
      }
      if (method === "session.renew") return { answerSdp: "renewal answer" };
      if (method === "session.alive") return { live: true };
      return null;
    },
  };
  return { rpc: rpc as never, calls, renewFails };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  legs.length = 0;
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal(
    "Audio",
    class {
      autoplay = false;
      srcObject: unknown = null;
      play() {
        return Promise.resolve();
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the voice controller", () => {
  it("names the window's client and machine at Talk, for the voice hooks", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc, async () => "host_mine");
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    expect(calls.find((call) => call.method === "session.start")?.input).toEqual({ sdp: "v=0 offer 1", hostId: "host_mine", client: "desktop" });
    await voice.end("ended by the captain");
  });

  it("starts the session with no machine when the lookup fails or none was handed over", async () => {
    for (const machine of [async () => Promise.reject(new Error("no daemon")), undefined]) {
      legs.length = 0;
      const asks = pendingMicrophone();
      const { rpc, calls } = fakeRpc();
      const voice = new VoiceController();
      voice.attach(rpc, machine);
      voice.talk();
      asks[0]?.resolve(fakeStream().stream);
      await flush();
      expect(calls.find((call) => call.method === "session.start")?.input).toMatchObject({ hostId: null, client: "desktop" });
      expect(voice.snapshot.phase).toBe("live");
      await voice.end("ended by the captain");
    }
  });

  it("stops the microphone granted after End, and starts no server call", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    await voice.end("ended by the captain");
    expect(voice.snapshot.phase).toBe("idle");
    // It says why, so the pill shows the ended state with Talk again.
    expect(voice.snapshot.note).toBe("Voice ended: ended by the captain.");
    const { stream, track } = fakeStream();
    asks[0]?.resolve(stream);
    await flush();
    expect(track.stopped).toBe(true);
    expect(calls.filter((call) => call.method === "session.start")).toEqual([]);
    expect(voice.snapshot.phase).toBe("idle");
  });

  it("lets an earlier attempt clean up only its own microphone when Talk is tapped again", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    await voice.end("ended by the captain");
    voice.talk();
    const second = fakeStream();
    asks[1]?.resolve(second.stream);
    await flush();
    expect(voice.snapshot.phase).toBe("live");
    const first = fakeStream();
    asks[0]?.resolve(first.stream);
    await flush();
    expect(first.track.stopped).toBe(true);
    expect(second.track.stopped).toBe(false);
    expect(voice.snapshot.phase).toBe("live");
    expect(calls.filter((call) => call.method === "session.start")).toHaveLength(1);
    await voice.end("ended by the captain");
  });

  it("ends the server's session when End comes while the start is on its way", async () => {
    const asks = pendingMicrophone();
    const { calls } = fakeRpc();
    let release: () => void = () => {};
    const slow = {
      call: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === "session.start") {
          await new Promise<void>((resolve) => (release = resolve));
          return { sessionId: "fmv_slow", answerSdp: "answer" };
        }
        return null;
      },
    };
    const voice = new VoiceController();
    voice.attach(slow as never);
    voice.talk();
    const { stream, track } = fakeStream();
    asks[0]?.resolve(stream);
    await flush();
    await voice.end("ended by the captain");
    release();
    await flush();
    expect(track.stopped).toBe(true);
    expect(legs[0]?.closed).toBe(true);
    expect(calls.filter((call) => call.method === "session.end").map((call) => call.input.sessionId)).toEqual(["fmv_slow"]);
  });

  it("confirms a renewal only once the new leg connected, then retires the old leg", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    voice.onSignal({ sessionId: "fmv_1", type: "renew" });
    await flush();
    expect(calls.map((call) => call.method)).toEqual(["session.start", "session.renew", "session.renewed"]);
    expect(legs[0]?.closed).toBe(true);
    expect(legs[1]?.closed).toBe(false);
    expect(voice.snapshot.phase).toBe("live");
    await voice.end("ended by the captain");
  });

  /** An RPC whose answers to the named methods wait until the test releases them. */
  function heldRpc(held: string[]) {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    const waiting = new Map<string, () => void>();
    let sessions = 0;
    const rpc = {
      call: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (held.includes(method)) await new Promise<void>((resolve) => waiting.set(method, resolve));
        if (method === "session.start") {
          sessions += 1;
          return { sessionId: `fmv_${sessions}`, answerSdp: "answer" };
        }
        if (method === "session.renew") return { answerSdp: "renewal answer" };
        if (method === "session.alive") return { live: true };
        return null;
      },
    };
    return { rpc: rpc as never, calls, release: (method: string) => waiting.get(method)?.() };
  }

  it("leaves a newer session alone when an old renewal's acknowledgement comes back late", async () => {
    const asks = pendingMicrophone();
    const { rpc, release } = heldRpc(["session.renewed"]);
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    voice.onSignal({ sessionId: "fmv_1", type: "renew" });
    await flush(); // the renewal's leg is up; its acknowledgement is held
    voice.onSignal({ sessionId: "fmv_1", type: "state", state: "ended", reason: "the hour ran out" });
    voice.talk();
    const fresh = fakeStream();
    asks[1]?.resolve(fresh.stream);
    await flush();
    expect(voice.snapshot.phase).toBe("live");
    const freshLeg = legs[2]!;
    release("session.renewed");
    await flush();
    expect(legs[1]?.closed).toBe(true); // the obsolete renewal leg closed itself
    expect(freshLeg.closed).toBe(false);
    expect(fresh.track.stopped).toBe(false);
    expect(voice.snapshot.phase).toBe("live");
    await voice.end("ended by the captain");
  });

  it("leaves a newer session alone when End's answer comes back after the ended signal and a new Talk", async () => {
    const asks = pendingMicrophone();
    const { rpc, release } = heldRpc(["session.end"]);
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    const ending = voice.end("ended by the captain");
    voice.onSignal({ sessionId: "fmv_1", type: "state", state: "ended", reason: "ended by the captain" });
    expect(voice.snapshot.phase).toBe("idle");
    voice.talk();
    const fresh = fakeStream();
    asks[1]?.resolve(fresh.stream);
    await flush();
    expect(voice.snapshot.phase).toBe("live");
    release("session.end");
    await ending;
    await flush();
    expect(voice.snapshot.phase).toBe("live");
    expect(fresh.track.stopped).toBe(false);
    expect(legs[1]?.closed).toBe(false);
  });

  it("ends the session when the renewal's leg fails after the server made the call", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    const { stream, track } = fakeStream();
    asks[0]?.resolve(stream);
    await flush();
    const failing = vi.spyOn(FakeLeg.prototype, "connected").mockRejectedValueOnce(new Error("ICE failed"));
    voice.onSignal({ sessionId: "fmv_1", type: "renew" });
    await flush();
    failing.mockRestore();
    expect(calls.map((call) => call.method)).toEqual(["session.start", "session.renew", "session.end"]);
    expect(calls.at(-1)?.input).toEqual({ sessionId: "fmv_1", reason: "the renewal could not connect" });
    expect(voice.snapshot.phase).toBe("idle");
    expect(track.stopped).toBe(true);
    expect(legs.every((leg) => leg.closed)).toBe(true);
  });
});
