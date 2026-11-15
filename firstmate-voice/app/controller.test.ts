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
  it("stops the microphone granted after End, and starts no server call", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    await voice.end("ended by the captain");
    expect(voice.snapshot.phase).toBe("idle");
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
