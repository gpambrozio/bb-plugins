// @vitest-environment jsdom
/**
 * Herald's sentences in the thread's timeline: registered where bb has
 * message metadata (and the composer banner where it has none), each drawn as
 * a card above the message the server placed it on, and read once per thread
 * for all its messages.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ExperimentalMessageMetadataProps, PluginAppBuilder, PluginAppSlots } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_STORED_CONFIG, SENTENCES_CHANNEL, type AttentionReason, type PlacedSentences, type RecentHistoryItem } from "../shared/herald";
import { NO_CHOICE } from "../shared/thread-choice";
import { HeraldBanner } from "./banner";
import { HeraldBridge } from "./bridge";
import { registerTimelineSentences, TimelineSentencesAbove } from "./timeline";

afterEach(() => cleanup());

const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);

type Message = ExperimentalMessageMetadataProps["message"];

function userMessage(id: string, second: number): Message {
  return { id, threadId: "t1", createdAt: T0 + second * 1000, turnId: null, role: "user", initiator: "user" };
}

function answer(id: string, second: number): Message {
  return { id, threadId: "t1", createdAt: T0 + second * 1000, turnId: "turn1", role: "assistant" };
}

function backend(placed: () => PlacedSentences, reads: string[]) {
  return {
    list: () => ({ entries: [] }),
    "config.get": () => DEFAULT_STORED_CONFIG,
    "config.set": () => DEFAULT_STORED_CONFIG,
    "history.list": () => ({ items: [] }),
    "history.recent": () => ({ items: [] as RecentHistoryItem[] }),
    "history.placed": ({ threadId }: { threadId: string }) => {
      reads.push(threadId);
      return placed();
    },
    "speech.voices": () => ({ available: false, voices: [] }),
    "speech.render": () => ({ mimeType: "audio/wav", base64: "" }),
    "choices.list": () => ({ threads: {} }),
    "choices.set": () => NO_CHOICE,
    "choices.setMany": () => null,
    "push.status": () => ({ state: "off" as const, message: null }),
    log: () => null,
  };
}

function placed(sentences: Array<{ eventId: string; text: string; messageId: string; reason?: AttentionReason }>): PlacedSentences {
  return {
    sentences: sentences.map((sentence) => ({ reason: "finished" as const, ...sentence, createdAt: new Date(T0).toISOString() })),
  };
}

function renderMessage(message: Message, rpc: ReturnType<typeof backend>) {
  return renderSlot<ExperimentalMessageMetadataProps, RpcContract>({ component: TimelineSentencesAbove }, { message }, { rpc });
}

describe("Herald's sentences in the timeline", () => {
  it("are registered above messages on a bb with message metadata, in place of the composer banner", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.messageMetadata.map((registration) => [registration.id, registration.placement, registration.component])).toEqual([
      ["sentences", "above", TimelineSentencesAbove],
    ]);
    expect(app.composerCustomizations).toEqual([]);
  });

  it("leave a bb without the slot its composer banner, as before", async () => {
    expect(registerTimelineSentences({} as PluginAppSlots)).toBe(false);
    // The app's setup on a builder whose slots have no message metadata.
    const customizations: Array<{ banners?: Array<{ component: unknown }> }> = [];
    const slots = new Proxy({}, { get: (_target, name) => (name === "experimental_messageMetadata" ? undefined : () => {}) });
    const definition = (await import("../app")).default;
    definition.setup({
      slots,
      composer: { customize: (customization: (typeof customizations)[number]) => customizations.push(customization) },
      commands: { register: () => {} },
    } as unknown as PluginAppBuilder);
    expect(customizations.flatMap((customization) => customization.banners?.map((banner) => banner.component) ?? [])).toEqual([HeraldBanner]);
  });

  it("draws each sentence as a card on the message it was placed on, oldest first, reading once for the thread", async () => {
    const reads: string[] = [];
    // Newest first, as the server lists them: the finished turn's sentence, then the question's on the same answer.
    const rpc = backend(
      () =>
        placed([
          { eventId: "t1:idle:2", text: "Login fix is done.", messageId: "a2" },
          { eventId: "t1:interaction:i1", text: "Login fix asked which database.", messageId: "a2", reason: "question" },
        ]),
      reads,
    );
    renderMessage(userMessage("u1", 0), rpc);
    renderMessage(answer("a2", 30), rpc);
    await screen.findByText("Login fix is done.");
    const lines = Array.from(document.querySelectorAll("[data-herald-sentence]")).map((line) => line.textContent);
    expect(lines).toEqual(["Login fix asked which database.", "Login fix is done."]);
    // Labelled as the banner was.
    expect(screen.getByText("Herald · Question")).toBeTruthy();
    expect(screen.getByText("Herald · Finished")).toBeTruthy();
    expect(document.querySelectorAll("[data-herald-sentences]")).toHaveLength(1);
    expect(reads).toEqual(["t1"]);
  });

  it("shows a new sentence as soon as the server says its thread has one, and no other thread reads", async () => {
    const reads: string[] = [];
    let answerNow = placed([]);
    const rpc = backend(() => answerNow, reads);
    const bridge = renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, { rpc });
    renderMessage(answer("a1", 10), rpc);
    await waitFor(() => expect(reads).toEqual(["t1"]));
    answerNow = placed([{ eventId: "t1:idle:1", text: "Login fix is done.", messageId: "a1" }]);
    await bridge.emitRealtime(SENTENCES_CHANNEL, { threadId: "t2" });
    await bridge.emitRealtime(SENTENCES_CHANNEL, { nonsense: true });
    expect(reads).toEqual(["t1"]);
    await bridge.emitRealtime(SENTENCES_CHANNEL, { threadId: "t1" });
    await screen.findByText("Login fix is done.");
    expect(reads).toEqual(["t1", "t1"]);
  });

  it("moves a question's sentence to the turn's final answer when the turn ends, even quietly", async () => {
    const reads: string[] = [];
    // While the turn runs, the question's sentence sits on the answer before it, for now.
    let answerNow = placed([{ eventId: "t1:interaction:i1", text: "Login fix asked which database.", messageId: "a1", reason: "question" }]);
    const rpc = backend(() => answerNow, reads);
    const bridge = renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, { rpc });
    const intermediate = renderMessage(answer("a1", 10), rpc);
    renderMessage(answer("a2", 30), rpc);
    await screen.findByText("Login fix asked which database.");
    expect(reads).toEqual(["t1"]);
    // The turn ends with no sentence of its own (the tool kept it quiet): the end alone nudges the
    // thread, the first answer folds into "Worked for", and the sentence moves to the final answer.
    answerNow = placed([{ eventId: "t1:interaction:i1", text: "Login fix asked which database.", messageId: "a2", reason: "question" }]);
    intermediate.unmount();
    await bridge.emitRealtime(SENTENCES_CHANNEL, { threadId: "t1" });
    await waitFor(() => expect(reads).toEqual(["t1", "t1"]));
    await screen.findByText("Login fix asked which database.");
    expect(document.querySelectorAll("[data-herald-sentences]")).toHaveLength(1);
  });
});
