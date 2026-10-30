// @vitest-environment jsdom
/**
 * Herald's sentences in the thread's timeline: registered where bb has
 * message metadata and not where it has none, each drawn above the message
 * the server placed it on, and read once per thread for all its messages.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ExperimentalMessageMetadataProps, PluginAppSlots } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_STORED_CONFIG, SENTENCES_CHANNEL, type PlacedSentences, type RecentHistoryItem } from "../shared/herald";
import { NO_CHOICE } from "../shared/thread-choice";
import { HeraldBridge } from "./bridge";
import { registerTimelineSentences, TimelineSentencesAbove } from "./timeline";

afterEach(() => cleanup());

const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);

type Message = ExperimentalMessageMetadataProps["message"];

function userMessage(id: string, second: number, threadId = "t1"): Message {
  return { id, threadId, createdAt: T0 + second * 1000, turnId: null, role: "user", initiator: "user" };
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

function placed(sentences: Array<{ eventId: string; text: string; messageId: string }>, waitingSince: number | null = null): PlacedSentences {
  return {
    sentences: sentences.map((sentence) => ({ ...sentence, reason: "finished" as const, createdAt: new Date(T0).toISOString() })),
    waitingSince,
  };
}

function renderMessage(message: Message, rpc: ReturnType<typeof backend>) {
  return renderSlot<ExperimentalMessageMetadataProps, RpcContract>({ component: TimelineSentencesAbove }, { message }, { rpc });
}

describe("Herald's sentences in the timeline", () => {
  it("are registered above messages on a bb with message metadata", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.messageMetadata.map((registration) => [registration.id, registration.placement, registration.component])).toEqual([
      ["sentences", "above", TimelineSentencesAbove],
    ]);
  });

  it("are not registered on a bb without it, which keeps the banner and the tab only", () => {
    expect(registerTimelineSentences({} as PluginAppSlots)).toBe(false);
  });

  it("draws each sentence above the message it was placed on, oldest first, reading once for the thread", async () => {
    const reads: string[] = [];
    // Newest first, as the server lists them: a question's sentence and then the finished turn's, both before the prompt.
    const rpc = backend(
      () =>
        placed([
          { eventId: "t1:idle:2", text: "Login fix is done.", messageId: "u2" },
          { eventId: "t1:interaction:i1", text: "Login fix asked which database.", messageId: "u2" },
        ]),
      reads,
    );
    renderMessage(answer("a1", 10), rpc);
    renderMessage(userMessage("u2", 30), rpc);
    await screen.findByText("Login fix is done.");
    const lines = Array.from(document.querySelectorAll("[data-herald-sentence]")).map((span) => span.textContent);
    expect(lines).toEqual(["Login fix asked which database.", "Login fix is done."]);
    expect(document.querySelectorAll("[data-herald-sentences]")).toHaveLength(1);
    expect(reads).toEqual(["t1"]);
  });

  it("asks again, once, when a message newer than a waiting sentence shows", async () => {
    const reads: string[] = [];
    let answerNow = placed([], T0 + 11_000);
    const rpc = backend(() => answerNow, reads);
    renderMessage(answer("a1", 10), rpc);
    await waitFor(() => expect(reads).toEqual(["t1"]));
    answerNow = placed([{ eventId: "t1:idle:1", text: "Login fix is done.", messageId: "u2" }]);
    renderMessage(userMessage("u2", 30), rpc);
    await screen.findByText("Login fix is done.");
    expect(reads).toEqual(["t1", "t1"]);
    // Placed for good: another message shows and nothing is read.
    renderMessage(answer("a2", 40), rpc);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toEqual(["t1", "t1"]);
  });

  it("reads a thread on screen again when the server says it has a new sentence, and no other thread", async () => {
    const reads: string[] = [];
    let answerNow = placed([]);
    const rpc = backend(() => answerNow, reads);
    const bridge = renderSlot<object, RpcContract>({ component: HeraldBridge }, {}, { rpc });
    renderMessage(userMessage("u2", 30), rpc);
    await waitFor(() => expect(reads).toEqual(["t1"]));
    answerNow = placed([{ eventId: "t1:idle:1", text: "Login fix is done.", messageId: "u2" }]);
    await bridge.emitRealtime(SENTENCES_CHANNEL, { threadId: "t2" });
    await bridge.emitRealtime(SENTENCES_CHANNEL, { nonsense: true });
    expect(reads).toEqual(["t1"]);
    await bridge.emitRealtime(SENTENCES_CHANNEL, { threadId: "t1" });
    await screen.findByText("Login fix is done.");
    expect(reads).toEqual(["t1", "t1"]);
  });
});
