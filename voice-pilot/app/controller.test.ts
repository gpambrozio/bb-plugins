import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const legs: FakeLeg[] = [];
const platform = { value: "desktop" };

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
vi.mock("./platform", () => ({ voicePlatform: () => platform.value }));

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
  const resume: { fail: Error | null; live: boolean } = { fail: null, live: true };
  const rpc = {
    call: async (method: string, input: Record<string, unknown>) => {
      calls.push({ method, input });
      if (method === "session.start") {
        sessions += 1;
        return { sessionId: `vp_${sessions}`, answerSdp: "answer" };
      }
      if (method === "session.renew") return { answerSdp: "renewal answer" };
      if (method === "session.resume") {
        if (resume.fail !== null) throw resume.fail;
        return { answerSdp: "resume answer" };
      }
      if (method === "session.alive") return { live: resume.live };
      return null;
    },
  };
  return { rpc: rpc as never, calls, renewFails, resume };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** The page's visibility, as bb's mobile app leaving and coming back to the screen changes it. */
const page = {
  visibilityState: "visible",
  listeners: new Set<() => void>(),
  addEventListener(_type: string, listener: () => void) {
    page.listeners.add(listener);
  },
  removeEventListener(_type: string, listener: () => void) {
    page.listeners.delete(listener);
  },
  show(state: "visible" | "hidden") {
    page.visibilityState = state;
    for (const listener of page.listeners) listener();
  },
};

beforeEach(() => {
  legs.length = 0;
  platform.value = "desktop";
  page.visibilityState = "visible";
  page.listeners.clear();
  vi.stubGlobal("document", page);
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
    expect(calls.find((call) => call.method === "session.start")?.input).toEqual({ sdp: "v=0 offer 1", hostId: "host_mine", client: "desktop", threadId: null });
    await voice.end("ended by you");
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
      await voice.end("ended by you");
    }
  });

  it("stops the microphone granted after End, and starts no server call", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    await voice.end("ended by you");
    expect(voice.snapshot.phase).toBe("idle");
    // It says why, so the pill shows the ended state with Talk again.
    expect(voice.snapshot.note).toBe("Voice ended: ended by you.");
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
    await voice.end("ended by you");
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
    await voice.end("ended by you");
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
          return { sessionId: "vp_slow", answerSdp: "answer" };
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
    await voice.end("ended by you");
    release();
    await flush();
    expect(track.stopped).toBe(true);
    expect(legs[0]?.closed).toBe(true);
    expect(calls.filter((call) => call.method === "session.end").map((call) => call.input.sessionId)).toEqual(["vp_slow"]);
  });

  it("opens what the voice asks for, from this window, and keeps what it opened for the session card", async () => {
    const asks = pendingMicrophone();
    const { rpc } = fakeRpc();
    const voice = new VoiceController();
    const threads: string[] = [];
    const urls: string[] = [];
    voice.attach(rpc, undefined, (id) => threads.push(id), (url) => (urls.push(url), !url.includes("blocked")));
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    voice.onSignal({ sessionId: "vp_1", type: "open-link", url: "https://github.com/acme/web/pull/20", label: "github.com/acme/web/pull/20" });
    expect(urls).toEqual(["https://github.com/acme/web/pull/20"]);
    expect(voice.snapshot.opened).toEqual({ label: "github.com/acme/web/pull/20", ok: true });
    voice.onSignal({ sessionId: "vp_1", type: "open-link", url: "https://example.com/blocked", label: "example.com/blocked" });
    expect(voice.snapshot.opened).toEqual({ label: "example.com/blocked", ok: false });
    voice.onSignal({ sessionId: "vp_1", type: "open", threadId: "thr_a", label: "Fix the login test" });
    expect(threads).toEqual(["thr_a"]);
    expect(voice.snapshot.opened).toEqual({ label: "Fix the login test", ok: true });
    // Another session's signal opens nothing here.
    voice.onSignal({ sessionId: "vp_other", type: "open-link", url: "https://example.com/x", label: "example.com/x" });
    expect(urls).toHaveLength(2);
    await voice.end("ended by you");
    expect(voice.snapshot.opened).toBeNull();
  });

  it("confirms a renewal only once the new leg connected, then retires the old leg", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    voice.onSignal({ sessionId: "vp_1", type: "renew" });
    await flush();
    expect(calls.map((call) => call.method)).toEqual(["session.start", "session.renew", "session.renewed"]);
    expect(legs[0]?.closed).toBe(true);
    expect(legs[1]?.closed).toBe(false);
    expect(voice.snapshot.phase).toBe("live");
    await voice.end("ended by you");
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
          return { sessionId: `vp_${sessions}`, answerSdp: "answer" };
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
    voice.onSignal({ sessionId: "vp_1", type: "renew" });
    await flush(); // the renewal's leg is up; its acknowledgement is held
    voice.onSignal({ sessionId: "vp_1", type: "state", state: "ended", reason: "the hour ran out" });
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
    await voice.end("ended by you");
  });

  it("leaves a newer session alone when End's answer comes back after the ended signal and a new Talk", async () => {
    const asks = pendingMicrophone();
    const { rpc, release } = heldRpc(["session.end"]);
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    const ending = voice.end("ended by you");
    voice.onSignal({ sessionId: "vp_1", type: "state", state: "ended", reason: "ended by you" });
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
    voice.onSignal({ sessionId: "vp_1", type: "renew" });
    await flush();
    failing.mockRestore();
    expect(calls.map((call) => call.method)).toEqual(["session.start", "session.renew", "session.end"]);
    expect(calls.at(-1)?.input).toEqual({ sessionId: "vp_1", reason: "the renewal could not connect" });
    expect(voice.snapshot.phase).toBe("idle");
    expect(track.stopped).toBe(true);
    expect(legs.every((leg) => leg.closed)).toBe(true);
  });
});

describe("the window's screen", () => {
  it("names the thread on screen at Talk, tells the live session when it changes, and shows a thread the voice asks for", async () => {
    const asks = pendingMicrophone();
    const { rpc, calls } = fakeRpc();
    const shown: string[] = [];
    const voice = new VoiceController();
    voice.attach(rpc, undefined, (id) => shown.push(id));
    voice.focus("thr_a");
    voice.talk();
    asks[0]?.resolve(fakeStream().stream);
    await flush();
    expect(calls.find((call) => call.method === "session.start")?.input).toMatchObject({ threadId: "thr_a" });
    voice.focus("thr_b");
    voice.focus("thr_b");
    expect(calls.filter((call) => call.method === "session.focus").map((call) => call.input)).toEqual([{ sessionId: "vp_1", threadId: "thr_b" }]);
    voice.onSignal({ sessionId: "vp_1", type: "open", threadId: "thr_c" });
    voice.onSignal({ sessionId: "vp_other", type: "open", threadId: "thr_d" });
    expect(shown).toEqual(["thr_c"]);
    await voice.end("ended by you");
  });

  it("says nothing of the screen while no session is live", () => {
    const { rpc, calls } = fakeRpc();
    const voice = new VoiceController();
    voice.attach(rpc);
    voice.focus("thr_a");
    expect(calls).toEqual([]);
  });
});

describe("bb's mobile app leaving the screen", () => {
  /** A live session in the given client, with every microphone prompt answered at once. */
  async function live(client: "mobile" | "desktop") {
    platform.value = client;
    const tracks: FakeTrack[] = [];
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => {
          const { track, stream } = fakeStream();
          tracks.push(track);
          return stream;
        },
      },
    });
    const harness = fakeRpc();
    const voice = new VoiceController();
    voice.attach(harness.rpc);
    voice.talk();
    await flush();
    expect(voice.snapshot.phase).toBe("live");
    return { ...harness, voice, tracks };
  }

  it("pauses the session instead of ending it, and picks it up on a new leg when bb is back", async () => {
    const { voice, calls, tracks } = await live("mobile");
    voice.toggleMute();
    page.show("hidden");
    await flush();
    expect(voice.snapshot.phase).toBe("paused");
    expect(voice.active).toBe(true);
    expect(tracks[0]?.stopped).toBe(true);
    expect(legs[0]?.closed).toBe(true);
    expect(calls.find((call) => call.method === "session.pause")?.input).toEqual({ sessionId: "vp_1", reason: "bb left the screen" });
    expect(calls.some((call) => call.method === "session.end")).toBe(false);

    page.show("visible");
    await flush();
    expect(voice.snapshot.phase).toBe("live");
    expect(calls.find((call) => call.method === "session.resume")?.input).toEqual({ sessionId: "vp_1", sdp: "v=0 offer 2" });
    // A new microphone stream, muted as it was.
    expect(tracks).toHaveLength(2);
    expect(tracks[1]?.enabled).toBe(false);
    expect(voice.snapshot.muted).toBe(true);
    await voice.end("ended by you");
    expect(tracks[1]?.stopped).toBe(true);
    expect(legs[1]?.closed).toBe(true);
  });

  it("stays paused, with Resume, when the session cannot be picked up; ends here when the server ended it", async () => {
    const first = await live("mobile");
    first.resume.fail = new Error("The audio connection to OpenAI failed.");
    page.show("hidden");
    page.show("visible");
    await flush();
    expect(first.voice.snapshot.phase).toBe("paused");
    expect(first.voice.snapshot.note).toContain("Tap Resume to try again");
    expect(legs.at(-1)?.closed).toBe(true);
    first.resume.fail = null;
    await first.voice.resume();
    expect(first.voice.snapshot.phase).toBe("live");
    await first.voice.end("ended by you");

    const second = await live("mobile");
    second.resume.fail = new Error("That voice session is no longer live.");
    second.resume.live = false;
    page.show("hidden");
    page.show("visible");
    await flush();
    expect(second.voice.snapshot.phase).toBe("idle");
    expect(second.voice.snapshot.note).toBe("Voice ended while bb was away.");
  });

  it("follows the server when it paused the session, and ends a paused one on End", async () => {
    const { voice, calls } = await live("mobile");
    voice.onSignal({ sessionId: "vp_1", type: "state", state: "paused", reason: "the app stopped answering" });
    expect(voice.snapshot.phase).toBe("paused");
    expect(calls.some((call) => call.method === "session.pause")).toBe(false);
    voice.toggle();
    await flush();
    expect(calls.find((call) => call.method === "session.end")?.input).toEqual({ sessionId: "vp_1", reason: "ended by you" });
    expect(voice.snapshot.phase).toBe("idle");
  });

  it("mutes when the voice is asked to, as Mute does, and never unmutes", async () => {
    const { voice, tracks } = await live("desktop");
    voice.onSignal({ sessionId: "vp_1", type: "mute" });
    expect(voice.snapshot.muted).toBe(true);
    expect(tracks[0]?.enabled).toBe(false);
    voice.onSignal({ sessionId: "vp_1", type: "mute" });
    expect(voice.snapshot.muted).toBe(true);
    voice.onSignal({ sessionId: "vp_other", type: "mute" });
    voice.toggleMute();
    expect(tracks[0]?.enabled).toBe(true);
    await voice.end("ended by you");
  });

  it("keeps a desktop session running when its window is hidden", async () => {
    const { voice, calls } = await live("desktop");
    page.show("hidden");
    await flush();
    expect(voice.snapshot.phase).toBe("live");
    expect(calls.some((call) => call.method === "session.pause" || call.method === "session.end")).toBe(false);
    await voice.end("ended by you");
  });
});
