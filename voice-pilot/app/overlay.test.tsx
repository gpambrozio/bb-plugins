// @vitest-environment jsdom
/**
 * The pill is a bb toast: plain options and `{ label, onClick }` buttons, so bb draws it as its own card in its
 * own stack. While a call is live it offers Mute (or Unmute) and End; once it ends, Talk and Close. The overlay
 * draws nothing itself; it also tells the controller the thread on screen, and sends a debug-tab request with
 * no thread named to the Voice page.
 */
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { toast, type ExternalToast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { rpcContract } from "../server";
import type { VoiceState } from "./controller";

/**
 * bb's toast stack as far as the mock can tell it: the cards on screen by id. Showing a toast with an id on
 * screen updates that card; `dismiss` takes it away; a cancel button takes its own card away as it is pressed
 * (`pressCancel`), and a card still fading out can be pressed again.
 */
const cards = vi.hoisted(() => new Map<string | number, string>());
vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn((title: string, options?: { id?: string | number }) => {
      if (options?.id !== undefined) cards.set(options.id, title);
    }),
    { dismiss: vi.fn((id?: string | number) => void (id !== undefined && cards.delete(id))) },
  ),
}));

/** The window's voice controller, reduced to a state the test sets and the calls the toast's buttons make. */
const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const idle = { phase: "idle", muted: false, speaking: { user: false, voice: false }, note: null };
  const voice = {
    snapshot: idle as VoiceState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach: vi.fn(),
    focus: vi.fn(),
    onSignal: vi.fn(),
    talk: vi.fn(),
    toggleMute: vi.fn(),
    end: vi.fn(async () => undefined),
    dismiss: vi.fn(),
  };
  return {
    voice,
    idle: idle as VoiceState,
    set(next: Partial<VoiceState>) {
      voice.snapshot = { ...voice.snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("./controller", () => ({ voice: fake.voice }));

const { VOICE_TOAST_ID, VoicePill, voiceToast } = await import("./overlay");
const { debugOpen } = await import("./debug-view");

type Rpc = PluginRpcTestHandlers<typeof rpcContract>;

function stubs(): Rpc {
  return {} as Partial<Rpc> as Rpc;
}

/** The last toast shown, as sonner received it. */
function shown(): { title: string; options: ExternalToast } {
  const call = vi.mocked(toast).mock.calls.at(-1);
  if (!call) throw new Error("no toast shown");
  return { title: String(call[0]), options: call[1] ?? {} };
}

function click(button: unknown, prevent = vi.fn()): ReturnType<typeof vi.fn> {
  (button as { onClick(event: unknown): void }).onClick({ preventDefault: prevent });
  return prevent;
}

/** A cancel press as bb's card makes it: the button's own onClick, and its card dismissed. */
function pressCancel(options: ExternalToast): void {
  click(options.cancel);
  if (options.id !== undefined) cards.delete(options.id);
}

function live(next: Partial<VoiceState> = {}): Partial<VoiceState> {
  return { phase: "live", note: null, ...next };
}

beforeEach(() => {
  fake.voice.snapshot = fake.idle;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  cards.clear();
  debugOpen.done();
});

describe("the voice toast", () => {
  it("is not shown while there is nothing to say", async () => {
    const view = renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(fake.voice.attach).toHaveBeenCalled());
    expect(toast).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe("");
  });

  it("stays up while live, with the status in its title, Mute that keeps it up and End", async () => {
    fake.set(live({ speaking: { user: false, voice: true } }));
    renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const { title, options } = shown();
    expect(title).toBe("Voice Pilot · Speaking");
    expect(String(options.id)).toMatch(new RegExp(`^${VOICE_TOAST_ID}-`));
    expect(VOICE_TOAST_ID).toMatch(/^voice-pilot-session-[a-z0-9]+$/);
    expect(options).toMatchObject({ duration: Infinity, dismissible: false, description: undefined });
    expect(options.action).toMatchObject({ label: "Mute" });
    expect(options.cancel).toMatchObject({ label: "End" });

    // Every option is plain data: a string title and `{ label, onClick }` buttons, so bb draws its own card.
    for (const button of [options.action, options.cancel]) expect(Object.keys(button as object).sort()).toEqual(["label", "onClick"]);

    expect(click(options.action)).toHaveBeenCalled();
    expect(fake.voice.toggleMute).toHaveBeenCalledTimes(1);
  });

  it("changes in place as the call does, and reads Unmute while muted", async () => {
    fake.set(live());
    renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(shown().title).toBe("Voice Pilot · Listening"));
    const id = shown().options.id;
    act(() => fake.set({ muted: true }));
    await waitFor(() => expect(shown().title).toBe("Voice Pilot · Muted"));
    expect(shown().options.id).toBe(id);
    expect(shown().options.action).toMatchObject({ label: "Unmute" });
    // A render that changes nothing the toast says does not show it again.
    const times = vi.mocked(toast).mock.calls.length;
    act(() => fake.set({ muted: true }));
    expect(vi.mocked(toast).mock.calls.length).toBe(times);
  });

  it("goes to the ended state on End, in a new toast, with Talk that keeps it up and Close", async () => {
    fake.set(live());
    renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const first = shown().options;
    click(first.cancel);
    expect(fake.voice.end).toHaveBeenCalledWith("ended by you");

    act(() => fake.set({ phase: "ending" }));
    await waitFor(() => expect(shown().title).toBe("Voice Pilot · Ending…"));
    // sonner's cancel dismissed the first toast; this one is new, so it is not merged into the one fading out.
    expect(shown().options.id).not.toBe(first.id);
    expect(shown().options).toMatchObject({ action: undefined, cancel: undefined });

    act(() => fake.set({ phase: "idle", note: "Voice ended: ended by you." }));
    await waitFor(() => expect(shown().options.description).toBe("Voice ended: ended by you."));
    const ended = shown();
    expect(ended.title).toBe("Voice Pilot");
    expect(ended.options.action).toMatchObject({ label: "Talk" });
    expect(ended.options.cancel).toMatchObject({ label: "Close" });

    expect(click(ended.options.action)).toHaveBeenCalled();
    expect(fake.voice.talk).toHaveBeenCalledTimes(1);
    click(ended.options.cancel);
    expect(fake.voice.dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps track of the card on screen when End is pressed twice on a card fading out", async () => {
    fake.set(live());
    const view = renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const first = shown().options;
    pressCancel(first);
    // The controller is ending; its end RPC is still on its way.
    act(() => fake.set({ phase: "ending" }));
    await waitFor(() => expect(shown().title).toBe("Voice Pilot · Ending…"));
    const ending = shown().options.id;
    // The first card, still fading out, takes a second press.
    pressCancel(first);
    expect(fake.voice.end).toHaveBeenCalledTimes(1);
    expect([...cards.keys()]).toEqual([ending]);

    // The end RPC answers: the ended state is that same card, changed in place, and the only one on screen.
    act(() => fake.set({ phase: "idle", note: "Voice ended: ended by you." }));
    await waitFor(() => expect(shown().title).toBe("Voice Pilot"));
    expect(shown().options.id).toBe(ending);
    expect([...cards.entries()]).toEqual([[ending, "Voice Pilot"]]);

    view.unmount();
    expect(cards.size).toBe(0);
  });

  it("does not end a new call for a press on the old call's card still fading out", async () => {
    fake.set(live());
    renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const first = shown().options;
    pressCancel(first);
    act(() => fake.set({ phase: "idle", note: "Voice ended: ended by you." }));
    // Talk again at once: the new call's card offers End too.
    act(() => fake.set({ phase: "connecting", note: null }));
    await waitFor(() => expect(shown().title).toBe("Voice Pilot · Connecting…"));
    const second = shown().options.id;
    pressCancel(first);
    expect(fake.voice.end).toHaveBeenCalledTimes(1);
    expect([...cards.keys()]).toEqual([second]);
  });

  it("offers only End while connecting, and goes when there is nothing left to say", async () => {
    fake.set({ phase: "connecting", note: null });
    renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(shown().title).toBe("Voice Pilot · Connecting…"));
    expect(shown().options).toMatchObject({ action: undefined, cancel: { label: "End" } });
    const id = shown().options.id;
    act(() => fake.set({ phase: "idle", note: null }));
    await waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith(id));
  });

  it("does nothing for a button the state has moved past", async () => {
    fake.set(live());
    renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const stale = shown().options;
    act(() => fake.set({ phase: "ending" }));
    click(stale.action);
    expect(fake.voice.toggleMute).not.toHaveBeenCalled();
  });

  it("is taken away when the overlay unmounts", async () => {
    fake.set(live());
    const view = renderSlot({ component: VoicePill }, {}, { rpc: stubs() });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const id = shown().options.id;
    vi.mocked(toast.dismiss).mockClear();
    view.unmount();
    expect(toast.dismiss).toHaveBeenCalledWith(id);
  });

  it("says what Talk could not do, the same way", () => {
    expect(voiceToast({ ...fake.idle, note: "There is no microphone to listen with." })).toEqual({
      title: "Voice Pilot",
      description: "There is no microphone to listen with.",
      action: "talk",
      cancel: "close",
    });
    expect(voiceToast(fake.idle)).toBeNull();
  });
});

describe("a debug-tab request with no thread named", () => {
  it("goes to the Voice page, which shows the log", async () => {
    const view = renderSlot({ component: VoicePill }, {}, { rpc: stubs(), context: { threadId: null } });
    await waitFor(() => expect(fake.voice.attach).toHaveBeenCalled());
    act(() => debugOpen.ask(null));
    await waitFor(() => expect(view.navigateCalls).toEqual([expect.objectContaining({ method: "toPluginPanel", path: "voice" })]));
    expect(debugOpen.wanted).toBeNull();
  });
});

describe("the window", () => {
  it("tells the controller which thread is on its screen, and how to show one", async () => {
    const view = renderSlot({ component: VoicePill }, {}, { rpc: stubs(), context: { threadId: "thr_shown" } });
    await waitFor(() => expect(fake.voice.focus).toHaveBeenCalledWith("thr_shown"));
    const navigate = vi.mocked(fake.voice.attach).mock.calls[0]?.[2] as (id: string) => void;
    act(() => navigate("thr_next"));
    expect(view.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "thr_next" }));
  });
});
