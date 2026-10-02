// @vitest-environment jsdom
/**
 * The slots render, and the overlay keeps every one of them fed: it reads the
 * list on mount, again on each realtime nudge, and again when the connection
 * comes back. A throwing slot shows as a "plugin crashed" chip in bb, so a
 * render here is the cheapest check that none of them throw.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_STORED_CONFIG, ENTRIES_CHANNEL, TOOL_COMMANDS, type AttentionEntry, type StoredConfig } from "../shared/herald";
import { HeraldBanner } from "./banner";
import { HeraldBridge } from "./bridge";
import { HeraldPanel } from "./panel";
import { HeraldSettingsSection } from "./settings-section";

beforeEach(() => {
  // jsdom has the elements but implements no playback; the announcer needs
  // play() to answer, and the tests watch what it asks the server to render.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The cross-window claims live in localStorage.
  localStorage.clear();
  delete (window as { bbDesktop?: unknown }).bbDesktop;
});

function entry(overrides: Partial<AttentionEntry> = {}): AttentionEntry {
  return {
    threadId: "t1",
    projectId: "p1",
    projectName: "Shop",
    threadTitle: "Login fix",
    lastRequest: "Fix the login bug",
    folder: "shop",
    reason: "finished",
    eventId: "t1:idle:1",
    requestId: null,
    createdAt: new Date().toISOString(),
    headline: "Finished",
    detail: "I fixed auth.ts.",
    summary: { status: "ready", text: "Login fix is done." },
    ...overrides,
  };
}

const sidebarThread = {
  id: "t1",
  projectId: "p1",
  title: "Login fix",
  titleFallback: null,
  displayTitle: "Login fix",
  status: "idle",
  isHidden: false,
  isArchived: false,
  isUnread: true,
  hasPendingInteraction: false,
  indicator: "unread-success",
  latestAttentionAt: Date.now(),
} as never;

function rpc(entries: () => AttentionEntry[], calls: { list: number }) {
  return {
    list: () => {
      calls.list += 1;
      return { entries: entries() };
    },
    "config.get": () => DEFAULT_STORED_CONFIG,
    "config.set": () => DEFAULT_STORED_CONFIG,
    "speech.voices": () => ({ available: true, voices: [{ name: "Zoe (Premium)", lang: "en_US" }] }),
    "speech.render": () => ({ mimeType: "audio/wav", base64: "" }),
    log: () => null,
  };
}

describe("Herald's app", () => {
  it("registers its page, overlay, banner and settings section", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["waiting"]);
    expect(app.appOverlays).toHaveLength(1);
    expect(app.composerCustomizations[0]?.banners?.map((banner) => banner.id)).toEqual(["summary"]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["summaries"]);
  });

  it("lists what the overlay reads, and re-reads on a nudge and on reconnect", async () => {
    let current = [entry()];
    const calls = { list: 0 };
    const bridge = renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, { rpc: rpc(() => current, calls) });
    renderSlot<object, RpcContract>(
      { component: HeraldPanel },
      {},
      { rpc: rpc(() => current, calls), sidebarThreads: { status: "ready", threads: [sidebarThread] } },
    );
    await screen.findByText("Login fix is done.");
    expect(screen.getByText("Fix the login bug")).toBeTruthy();

    current = [entry({ eventId: "t1:idle:2", summary: { status: "ready", text: "Login fix is done again." } })];
    await bridge.emitRealtime(ENTRIES_CHANNEL, { at: 1 });
    await screen.findByText("Login fix is done again.");

    const before = calls.list;
    await bridge.setRealtimeConnectionState("reconnecting");
    await bridge.setRealtimeConnectionState("connected");
    await waitFor(() => expect(calls.list).toBeGreaterThan(before));
  });

  it("shows the sentence above the waiting thread's composer, and nothing elsewhere", async () => {
    const calls = { list: 0 };
    renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, { rpc: rpc(() => [entry({ eventId: "t1:idle:3" })], calls) });
    const options = { sidebarThreads: { status: "ready" as const, threads: [sidebarThread] } };
    renderSlot({ component: HeraldBanner }, {}, { ...options, composer: { scope: { kind: "thread", threadId: "t1" } } });
    await screen.findByText("Herald · Finished");
    cleanup();
    renderSlot({ component: HeraldBanner }, {}, { ...options, composer: { scope: { kind: "thread", threadId: "other" } } });
    expect(screen.queryByText(/Herald ·/)).toBeNull();
  });

  it("keeps the sentence above the composer once the thread is read and working again", async () => {
    const calls = { list: 0 };
    renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, { rpc: rpc(() => [entry({ eventId: "t1:idle:5" })], calls) });
    const readAndWorking = { ...(sidebarThread as object), isUnread: false, status: "active", indicator: "none" } as never;
    renderSlot(
      { component: HeraldBanner },
      {},
      { sidebarThreads: { status: "ready" as const, threads: [readAndWorking] }, composer: { scope: { kind: "thread", threadId: "t1" } } },
    );
    await screen.findByText("Login fix is done.");
  });

  it("speaks a new sentence from the overlay alone, with no Herald page open", async () => {
    // The desktop app, showing some other page: only the overlay is mounted.
    (window as { bbDesktop?: unknown }).bbDesktop = {};
    let current: AttentionEntry[] = [];
    const calls = { list: 0 };
    const bridge = renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, { rpc: rpc(() => current, calls), pluginId: "herald" });
    await waitFor(() => expect(calls.list).toBe(1));
    current = [entry({ eventId: "t1:idle:9", summary: { status: "ready", text: "Login fix finished." } })];
    await bridge.emitRealtime(ENTRIES_CHANNEL, { at: 2 });
    await waitFor(() =>
      expect(bridge.inspection.rpcCalls).toContainEqual({
        method: "speech.render",
        input: { text: "Login fix finished.", voice: "", rate: 1 },
      }),
    );
  });

  it("has Settings instead of Refresh, and opens Herald's settings page", async () => {
    const calls = { list: 0 };
    const push = vi.spyOn(window.history, "pushState");
    renderSlot<object, RpcContract>(
      { component: HeraldPanel },
      {},
      { rpc: rpc(() => [], calls), pluginId: "herald", sidebarThreads: { status: "ready", threads: [] } },
    );
    expect(screen.queryByLabelText("Refresh")).toBeNull();
    fireEvent.click(screen.getByLabelText("Herald settings"));
    expect(push).toHaveBeenCalledWith(expect.anything(), "", "/settings/plugins/herald");
  });

  it("reads a card's sentence again on request, even when muted here, and not when there is none", async () => {
    let current = [entry({ eventId: "t1:idle:10" })];
    const calls = { list: 0 };
    const options = { rpc: rpc(() => current, calls), sidebarThreads: { status: "ready" as const, threads: [sidebarThread] } };
    const bridge = renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, options);
    renderSlot<object, RpcContract>({ component: HeraldPanel }, {}, options);
    await screen.findByText("Login fix is done.");
    fireEvent.click(screen.getByLabelText("Mute on this device"));
    fireEvent.click(screen.getByLabelText("Read again"));
    await waitFor(() =>
      expect(bridge.inspection.rpcCalls).toContainEqual({
        method: "speech.render",
        input: { text: "Login fix is done.", voice: "", rate: 1 },
      }),
    );
    fireEvent.click(screen.getByLabelText("Unmute on this device"));

    current = [entry({ eventId: "t1:idle:11", summary: { status: "off", fallback: "Login fix finished." } })];
    await bridge.emitRealtime(ENTRIES_CHANNEL, { at: 3 });
    await screen.findByText(/Not announced/);
    expect((screen.getByLabelText("Read again") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the sentence is being written, on the card and above the composer, until it lands", async () => {
    let current = [entry({ eventId: "t1:idle:20", summary: { status: "pending", fallback: "Login fix finished." } })];
    const calls = { list: 0 };
    const options = { rpc: rpc(() => current, calls), sidebarThreads: { status: "ready" as const, threads: [sidebarThread] } };
    const bridge = renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, options);
    renderSlot<object, RpcContract>({ component: HeraldPanel }, {}, options);
    renderSlot({ component: HeraldBanner }, {}, { ...options, composer: { scope: { kind: "thread", threadId: "t1" } } });
    expect(await screen.findAllByText("Writing the sentence…")).toHaveLength(2);
    // The card's button waits, disabled; the banner shows none until there is a sentence.
    expect(screen.getAllByLabelText("Read again").map((button) => (button as HTMLButtonElement).disabled)).toEqual([true]);
    current = [entry({ eventId: "t1:idle:20", summary: { status: "ready", text: "Login fix is done." } })];
    await bridge.emitRealtime(ENTRIES_CHANNEL, { at: 4 });
    expect(await screen.findAllByText("Login fix is done.")).toHaveLength(2);
    expect(screen.queryByText("Writing the sentence…")).toBeNull();
  });

  it("renders the settings section with the model controls together, and the voices", async () => {
    const calls = { list: 0 };
    renderSlot<object, RpcContract>({ component: HeraldSettingsSection }, {}, { rpc: rpc(() => [], calls) });
    await screen.findByText("Zoe (Premium)");
    expect((screen.getByLabelText("Tool that writes the sentence") as HTMLSelectElement).value).toBe("claude");
    expect(screen.queryByLabelText("Custom command")).toBeNull();
    expect((screen.getByLabelText("Sentence prompt") as HTMLTextAreaElement).value).toBe(DEFAULT_STORED_CONFIG.sentencePrompt);
  });

  it("shows the custom command only while that is the tool, seeded by the server, and saves it and the prompt", async () => {
    const calls = { list: 0 };
    let stored: StoredConfig = { ...DEFAULT_STORED_CONFIG };
    const backend = {
      ...rpc(() => [], calls),
      "config.get": () => stored,
      "config.set": (input: Partial<StoredConfig>) => {
        // The server seeds a blank custom command from the tool before.
        const seeded = input.sentenceTool === "custom" && stored.sentenceTool !== "custom" && stored.sentenceCommand === "" ? TOOL_COMMANDS[stored.sentenceTool as "claude"] : undefined;
        stored = { ...stored, ...input, ...(seeded === undefined ? {} : { sentenceCommand: seeded }) };
        return stored;
      },
    };
    renderSlot<object, RpcContract>({ component: HeraldSettingsSection }, {}, { rpc: backend });
    const select = (await screen.findByLabelText("Tool that writes the sentence")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "custom" } });
    const field = (await screen.findByLabelText("Custom command")) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe(TOOL_COMMANDS.claude));
    fireEvent.change(field, { target: { value: "my-llm --fast" } });
    fireEvent.click(screen.getByText("Save command"));
    await waitFor(() => expect(stored.sentenceCommand).toBe("my-llm --fast"));
    const prompt = screen.getByLabelText("Sentence prompt") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "Say: {{headline}}" } });
    fireEvent.click(screen.getByText("Save prompt"));
    await waitFor(() => expect(stored.sentencePrompt).toBe("Say: {{headline}}"));
    fireEvent.click(screen.getByText("Reset to the default prompt"));
    await waitFor(() => expect(stored.sentencePrompt).toBe(DEFAULT_STORED_CONFIG.sentencePrompt));
    fireEvent.change(select, { target: { value: "claude" } });
    await waitFor(() => expect(screen.queryByLabelText("Custom command")).toBeNull());
  });
});
