// @vitest-environment jsdom
/**
 * A card's backlog actions and its Answer box: an action sends its prompt to the first mate, the Answer box
 * sends the typed words under the task's id and title, and both wait while another send is out.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BacklogItem, FleetCard } from "../shared/types";
import { Card } from "./card";
import { answerText } from "./format";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MERGE = { label: "Merge", prompt: "Merge https://github.com/you/web/pull/42 once its checks are green" };
const WAIT = { label: "Wait", prompt: "Leave https://github.com/you/web/pull/42 open until Monday" };

function backlog(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    section: "queued",
    id: "pick-db",
    title: "Choose the database",
    project: "web",
    kind: "captain",
    mode: null,
    threadId: null,
    hold: "Postgres or SQLite?",
    actions: [MERGE, WAIT],
    blockedBy: null,
    since: null,
    url: null,
    reportPath: null,
    outcome: null,
    ...overrides,
  };
}

function cardOf(item: BacklogItem): FleetCard {
  return {
    key: item.id,
    column: item.hold === null ? "queued" : "blocked",
    taskId: item.id,
    title: item.title,
    project: item.project,
    kind: item.kind,
    backlog: item,
    crew: null,
    report: null,
    url: null,
  };
}

/** `ask` answers `mate.ask`; a promise that has not settled keeps the send in flight. */
function renderCard(item: BacklogItem, ask: () => unknown = () => null) {
  const changed: unknown[] = [];
  const view = renderSlot(
    { component: Card },
    { card: cardOf(item), mateThreadId: "thr_mate", onChanged: () => changed.push(null) },
    { rpc: { "mate.ask": ask } },
  );
  return { ...view, changed };
}

function actionButton(action: { label: string; prompt: string }): HTMLButtonElement {
  return screen.getByRole("button", { name: `${action.label}: send "${action.prompt}" to the first mate` }) as HTMLButtonElement;
}

const answerBox = () => screen.getByRole("textbox", { name: "Answer for pick-db" }) as HTMLInputElement;
const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("Card actions", () => {
  it("shows a held card's actions under the captain's call, most likely first", () => {
    renderCard(backlog());
    expect(screen.getByText("Captain's call:")).toBeTruthy();
    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels.slice(0, 2)).toEqual(["Merge", "Wait"]);
  });

  it("sends an action's prompt to the first mate and brings its thread into view", async () => {
    const view = renderCard(backlog());
    fireEvent.click(actionButton(WAIT));
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: WAIT.prompt } }]);
    expect(toast.success).toHaveBeenCalledWith("Sent to the first mate.");
    expect(view.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_mate" }]);
  });

  it("shows actions on a card with no hold, and no Answer box there", () => {
    renderCard(backlog({ hold: null, kind: "ship", actions: [MERGE] }));
    expect(actionButton(MERGE)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("draws no actions where the item has none", () => {
    renderCard(backlog({ actions: [] }));
    expect(screen.queryByRole("button", { name: /to the first mate$/ })).toBeNull();
    expect(answerBox()).toBeTruthy();
  });

  it("keeps every action and the Answer box disabled while a send is out, and sends once", async () => {
    let land: (value: null) => void = () => {};
    const view = renderCard(backlog(), () => new Promise((resolve) => (land = resolve)));
    fireEvent.click(actionButton(MERGE));
    fireEvent.click(actionButton(MERGE));
    await waitFor(() => expect(actionButton(MERGE).disabled).toBe(true));
    expect(actionButton(WAIT).disabled).toBe(true);
    fireEvent.change(answerBox(), { target: { value: "Postgres" } });
    expect(sendButton().disabled).toBe(true);
    expect(view.rpcCalls).toHaveLength(1);

    land(null);
    await waitFor(() => expect(actionButton(MERGE).disabled).toBe(false));
    expect(sendButton().disabled).toBe(false);
  });

  it("keeps the card as it was, and says why, when the send fails", async () => {
    const view = renderCard(backlog(), () => {
      throw new Error("The first mate is not aboard.");
    });
    fireEvent.change(answerBox(), { target: { value: "Postgres" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The first mate is not aboard."));
    expect(answerBox().value).toBe("Postgres");
    expect(view.changed).toEqual([]);
    expect(view.navigateCalls).toEqual([]);
  });
});

describe("Answer box", () => {
  it("sends the typed words under the task's id and title, then clears", async () => {
    const view = renderCard(backlog());
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(answerBox(), { target: { value: "  SQLite, for now  " } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: "pick-db — Choose the database: SQLite, for now" } }]);
    expect(answerBox().value).toBe("");
    expect(view.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_mate" }]);
  });

  it("sends on Enter", async () => {
    const view = renderCard(backlog({ actions: [] }));
    fireEvent.change(answerBox(), { target: { value: "Postgres" } });
    fireEvent.submit(answerBox().form as HTMLFormElement);
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: answerText(backlog(), "Postgres") } }]);
  });

  it("sends nothing for blank words", () => {
    const view = renderCard(backlog());
    fireEvent.change(answerBox(), { target: { value: "   " } });
    fireEvent.submit(answerBox().form as HTMLFormElement);
    expect(view.rpcCalls).toEqual([]);
  });
});
