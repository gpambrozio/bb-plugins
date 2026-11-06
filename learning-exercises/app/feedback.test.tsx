// @vitest-environment jsdom
/**
 * The agent's feedback in the chat (thr_9fuduh4nry): a card above the last message of the turn that
 * recorded it, which is what bb leaves in view once the turn folds into "Worked for".
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { FeedbackCard } from "../shared/types";
import { FEEDBACK_METADATA_ID, FeedbackAboveMessage } from "./feedback";

afterEach(() => cleanup());

type Message = ExperimentalMessageMetadataProps["message"];

const THREAD = "thr_fork";
const WORKSPACE = { threadId: THREAD, environmentId: "env_1", rootPath: "/work/calc" };

function card(ordinal: number, turnId: string, feedback: string, verdict: FeedbackCard["verdict"] = "partly"): FeedbackCard {
  return { sessionId: "ses_1", ordinal, turnId, verdict, feedback, workspace: WORKSPACE };
}

function assistant(id: string, turnId: string | null, createdAt: number): Message {
  return { id, threadId: THREAD, createdAt, turnId, role: "assistant" };
}

/** The tool result bb delivers as a system message, which starts the agent's next turn. */
function prompt(id: string, turnId: string, createdAt: number): Message {
  return { id, threadId: THREAD, createdAt, turnId, role: "user", initiator: "system" };
}

function backend(cards: FeedbackCard[], reads: string[] = []) {
  return {
    feedbackCards: ({ threadId }: { threadId: string }) => {
      reads.push(threadId);
      return { cards: threadId === THREAD ? cards : [] };
    },
  } as never;
}

function renderMessage(message: Message, rpc: ReturnType<typeof backend>) {
  const rendered = renderSlot<ExperimentalMessageMetadataProps, RpcContract>({ component: FeedbackAboveMessage }, { message }, { rpc });
  return { ...rendered, cards: () => Array.from(rendered.container.querySelectorAll("[data-learning-feedback] section")).map((section) => section.getAttribute("aria-label")) };
}

describe("the feedback card in the chat", () => {
  it("is registered above messages", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.messageMetadata.map((registration) => [registration.id, registration.placement, registration.component])).toEqual([[FEEDBACK_METADATA_ID, "above", FeedbackAboveMessage]]);
  });

  it("sits above the last message of its turn, with the verdict and then the feedback", async () => {
    const rpc = backend([card(7, "turn_8", "You named testability, but not **why**.")]);
    const answerPrompt = renderMessage(prompt("u8", "turn_8", 100), rpc);
    const closing = renderMessage(assistant("a8", "turn_8", 300), rpc);
    // Another turn's message, and a message outside any turn, get nothing.
    const earlier = renderMessage(assistant("a7", "turn_7", 50), rpc);
    const outside = renderMessage(assistant("a0", null, 10), rpc);
    await waitFor(() => expect(closing.cards()).toEqual(["Feedback on question 7"]));
    expect(answerPrompt.cards()).toEqual([]);
    expect(earlier.cards()).toEqual([]);
    expect(outside.cards()).toEqual([]);
    const section = screen.getByRole("region", { name: "Feedback on question 7" });
    expect(section.textContent).toContain("Partly right");
    expect(section.textContent).toContain("You named testability, but not **why**.");
    expect(section.textContent!.indexOf("Partly right")).toBeLessThan(section.textContent!.indexOf("You named testability"));
  });

  it("follows the running turn's newest message, and stays on the last one when the turn folds the others away", async () => {
    const rpc = backend([card(1, "turn_2", "Right outcome.", "correct")]);
    const feedbackMessage = renderMessage(assistant("a1", "turn_2", 100), rpc);
    await waitFor(() => expect(feedbackMessage.cards()).toEqual(["Feedback on question 1"]));
    // The agent writes again in the same turn ("I've asked the second question…"): the card moves down.
    const waiting = renderMessage(assistant("a2", "turn_2", 200), rpc);
    await waitFor(() => expect(waiting.cards()).toEqual(["Feedback on question 1"]));
    expect(feedbackMessage.cards()).toEqual([]);
    // The turn ends: bb folds its earlier message into "Worked for", and only the last one stays.
    feedbackMessage.unmount();
    expect(waiting.cards()).toEqual(["Feedback on question 1"]);
    // Expanding the fold shows the earlier message again; the card stays on the last one, once.
    const expanded = renderMessage(assistant("a1", "turn_2", 100), rpc);
    await waitFor(() => expect(document.querySelectorAll("[data-learning-feedback]")).toHaveLength(1));
    expect(expanded.cards()).toEqual([]);
  });

  it("falls back to the turn's prompt when the turn wrote no message, and shows every card of the turn in order", async () => {
    const rpc = backend([card(2, "turn_3", "Second."), card(3, "turn_3", "Third.", "skipped")]);
    const only = renderMessage(prompt("u3", "turn_3", 100), rpc);
    await waitFor(() => expect(only.cards()).toEqual(["Feedback on question 2", "Feedback on question 3"]));
    expect(screen.getByRole("region", { name: "Feedback on question 3" }).textContent).toContain("Skipped");
    // An assistant message of the turn arrives: the card moves there.
    const message = renderMessage(assistant("a3", "turn_3", 50), rpc);
    await waitFor(() => expect(message.cards()).toEqual(["Feedback on question 2", "Feedback on question 3"]));
    expect(only.cards()).toEqual([]);
  });

  it("the same message in two panes shows the card in both, and one pane closing leaves the other's", async () => {
    const rpc = backend([card(1, "turn_2", "Right outcome.")]);
    const left = renderMessage(assistant("a2", "turn_2", 200), rpc);
    const right = renderMessage(assistant("a2", "turn_2", 200), rpc);
    await waitFor(() => expect([left.cards(), right.cards()]).toEqual([["Feedback on question 1"], ["Feedback on question 1"]]));
    left.unmount();
    expect(right.cards()).toEqual(["Feedback on question 1"]);
  });

  it("survives a reload: it is drawn from the stored feedback and bb's turn ids, not from what this page saw", async () => {
    const reads: string[] = [];
    const rpc = backend([card(7, "turn_8", "Kept.")], reads);
    // A fresh page shows only the folded turn's last message; nothing from before the reload is needed.
    const closing = renderMessage(assistant("a8", "turn_8", 300), rpc);
    await waitFor(() => expect(closing.cards()).toEqual(["Feedback on question 7"]));
    expect(reads).toContain(THREAD);
  });
});
