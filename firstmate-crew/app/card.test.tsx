// @vitest-environment jsdom
/**
 * A card's backlog actions and its Answer box: an action sends its prompt to the first mate, the Answer box —
 * on every card — sends the typed words under the card's id and title, and both wait while another send is out.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BacklogItem, CrewSummary, FleetCard } from "../shared/types";
import { Card } from "./card";
import { answerText } from "./format";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Unsent words outlive a card (`./drafts`); each test starts with none.
  window.localStorage.clear();
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

  it("shows actions on a card with no hold, and the Answer box there too", () => {
    renderCard(backlog({ hold: null, kind: "ship", actions: [MERGE] }));
    expect(actionButton(MERGE)).toBeTruthy();
    expect(answerBox().placeholder).toBe("Tell the first mate about this…");
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

  it("shuts the line while its send is out, so nothing newer can be typed and lost", async () => {
    let land: (value: null) => void = () => {};
    const view = renderCard(backlog(), () => new Promise((resolve) => (land = resolve)));
    fireEvent.change(answerBox(), { target: { value: "Postgres" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(answerBox().disabled).toBe(true));
    expect(sendButton().disabled).toBe(true);

    land(null);
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(answerBox().disabled).toBe(false);
    expect(answerBox().value).toBe("");
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: "pick-db — Choose the database: Postgres" } }]);
  });

  it("sends on Enter", async () => {
    const view = renderCard(backlog({ actions: [] }));
    fireEvent.change(answerBox(), { target: { value: "Postgres" } });
    fireEvent.submit(answerBox().form as HTMLFormElement);
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: answerText(backlog(), "Postgres") } }]);
  });

  it("asks a held card's question back as an answer", () => {
    renderCard(backlog());
    expect(answerBox().placeholder).toBe("Answer the first mate…");
  });

  it("is on a backlog card with no hold and no actions, and sends under its id and title", async () => {
    const view = renderCard(backlog({ hold: null, actions: [] }));
    expect(screen.queryByRole("button", { name: /to the first mate$/ })).toBeNull();
    fireEvent.change(answerBox(), { target: { value: "Start this one next" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: "pick-db — Choose the database: Start this one next" } }]);
  });

  it("sends nothing for blank words", () => {
    const view = renderCard(backlog());
    fireEvent.change(answerBox(), { target: { value: "   " } });
    fireEvent.submit(answerBox().form as HTMLFormElement);
    expect(view.rpcCalls).toEqual([]);
  });
});

describe("Notify parent", () => {
  function crewCard(parentNotifications: CrewSummary["parentNotifications"]): FleetCard {
    return {
      ...cardOf(backlog({ hold: null, actions: [], section: "in-flight" })),
      column: "working",
      crew: {
        threadId: "thr_worker",
        title: "Choose the database",
        status: "active",
        pendingInteractions: 0,
        parentNotifications,
        projectId: "proj_web",
        environmentId: "env_w",
        updatedAt: 0,
        task: "pick-db",
        kind: null,
        project: "web",
      },
    };
  }

  function renderCrewCard(parentNotifications: CrewSummary["parentNotifications"]) {
    return renderSlot({ component: Card }, { card: crewCard(parentNotifications), onChanged: () => {} });
  }

  it("says nothing for a worker that tells the first mate everything", () => {
    renderCrewCard("auto");
    expect(screen.queryByText(/Notify parent/)).toBeNull();
  });

  it("flags a worker whose finished turns the first mate isn't told about", () => {
    renderCrewCard("stuck");
    expect(screen.getByText("Notify parent is When stuck: the first mate isn't told when this worker finishes a turn.")).toBeTruthy();
  });

  it("flags a worker the first mate hears nothing from", () => {
    renderCrewCard("off");
    expect(screen.getByText("Notify parent is Off: the first mate isn't told anything about this worker.")).toBeTruthy();
  });
});

describe("Answer box on a crewmate card", () => {
  function workerCard(overrides: { taskId: string | null; backlog: BacklogItem | null; title: string }): FleetCard {
    return {
      key: "thr_worker",
      column: "idle",
      taskId: overrides.taskId,
      title: overrides.title,
      project: "web",
      kind: "ship",
      backlog: overrides.backlog,
      crew: {
        threadId: "thr_worker",
        title: overrides.title,
        status: "idle",
        pendingInteractions: 0,
        parentNotifications: "auto",
        projectId: "proj_web",
        environmentId: "env_w",
        updatedAt: 0,
        task: overrides.taskId,
        kind: "ship",
        project: "web",
      },
      report: { state: "done", text: "PR https://github.com/you/web/pull/42" },
      url: "https://github.com/you/web/pull/42",
    };
  }

  function renderWorker(card: FleetCard) {
    const changed: unknown[] = [];
    const view = renderSlot(
      { component: Card },
      { card, mateThreadId: "thr_mate", onChanged: () => changed.push(null) },
      { rpc: { "mate.ask": () => null } },
    );
    return { ...view, changed };
  }

  async function send(view: ReturnType<typeof renderWorker>, name: string, words: string) {
    const box = screen.getByRole("textbox", { name }) as HTMLInputElement;
    expect(box.placeholder).toBe("Tell the first mate about this…");
    fireEvent.change(box, { target: { value: words } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(view.changed).toHaveLength(1));
  }

  it("is on a worker's card with no actions, and sends under its backlog item", async () => {
    const item = backlog({ section: "in-flight", hold: null, actions: [], threadId: "thr_worker" });
    const view = renderWorker(workerCard({ taskId: "pick-db", backlog: item, title: item.title }));
    expect(screen.queryByRole("button", { name: /to the first mate$/ })).toBeNull();
    await send(view, "Answer for pick-db", "Is the PR green?");
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: "pick-db — Choose the database: Is the PR green?" } }]);
  });

  it("sends under the worker's task id when no backlog item matches it", async () => {
    const view = renderWorker(workerCard({ taskId: "crw-picker", backlog: null, title: "Pick the review agent" }));
    await send(view, "Answer for crw-picker", "Merge it");
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: "crw-picker — Pick the review agent: Merge it" } }]);
  });

  it("sends under the worker's thread id when it has no task id", async () => {
    const view = renderWorker(workerCard({ taskId: null, backlog: null, title: "A loose worker" }));
    await send(view, "Answer for thr_worker", "What is this one doing?");
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: "thr_worker — A loose worker: What is this one doing?" } }]);
  });
});
