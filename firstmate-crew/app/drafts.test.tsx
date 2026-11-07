// @vitest-environment jsdom
/**
 * Unsent words on the board survive a thread switch: leaving the first mate's thread unmounts the board, and
 * the board that mounts on the way back finds every card's Answer box, Steer or Relaunch line and a worker's
 * Note as they were left. Sending clears them; cards that left the board, and old words, are dropped.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BacklogItem, CrewSummary, Fleet, FleetCard } from "../shared/types";
import { Board } from "./board";
import { CrewPanel } from "./crew-panel";
import { DRAFTS_KEY, DRAFT_KEEP_MS, pruneDrafts, readDraft, writeDraft } from "./drafts";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function item(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    section: "queued",
    id,
    title: `Task ${id}`,
    project: "web",
    kind: "captain",
    mode: null,
    threadId: null,
    hold: "Postgres or SQLite?",
    actions: [],
    blockedBy: null,
    since: null,
    url: null,
    reportPath: null,
    outcome: null,
    ...overrides,
  };
}

function backlogCard(id: string): FleetCard {
  const backlog = item(id);
  return { key: `backlog:queued:${id}:0`, column: "blocked", taskId: id, title: backlog.title, project: "web", kind: "captain", backlog, crew: null, report: null, url: null };
}

function crew(threadId: string): CrewSummary {
  return {
    threadId,
    title: "A worker",
    status: "idle",
    pendingInteractions: 0,
    parentNotifications: "auto",
    projectId: "proj_web",
    environmentId: "env_w",
    updatedAt: 0,
    task: null,
    kind: "ship",
    project: "web",
  };
}

function workerCard(threadId: string): FleetCard {
  return { key: `crew:${threadId}`, column: "idle", taskId: null, title: "A worker", project: "web", kind: "ship", backlog: null, crew: crew(threadId), report: null, url: null };
}

function fleetOf(cards: FleetCard[]): Fleet {
  return { home: "/h", homeReady: true, mate: null, mateMissing: false, cards, suggestions: [], charter: { edited: false, outdated: false }, watches: [] };
}

function renderBoard(cards: FleetCard[], rpc: Record<string, () => unknown> = {}) {
  return renderSlot({ component: Board }, { fleet: fleetOf(cards), mateThreadId: "thr_mate", onChanged: () => undefined }, { rpc: { "mate.ask": () => null, ...rpc } });
}

const answerBox = (id: string) => screen.getByRole("textbox", { name: `Answer for ${id}` }) as HTMLInputElement;
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });

describe("the Answer box across a thread switch", () => {
  it("keeps what the captain typed when the board unmounts and mounts again", () => {
    renderBoard([backlogCard("pick-db"), backlogCard("pick-ui")]);
    type(answerBox("pick-db"), "SQLite, for now");
    cleanup(); // Leaving the first mate's thread unmounts the board.

    renderBoard([backlogCard("pick-db"), backlogCard("pick-ui")]);
    expect(answerBox("pick-db").value).toBe("SQLite, for now");
    expect(answerBox("pick-ui").value).toBe("");
  });

  it("keeps it across a refresh that brings a new fleet", () => {
    const view = renderBoard([backlogCard("pick-db")]);
    type(answerBox("pick-db"), "SQLite");
    view.rerender(<Board fleet={fleetOf([backlogCard("pick-db"), backlogCard("pick-ui")])} mateThreadId="thr_mate" onChanged={() => undefined} />);
    expect(answerBox("pick-db").value).toBe("SQLite");
  });

  it("clears it once it is sent, so the next board starts empty", async () => {
    const view = renderBoard([backlogCard("pick-db")]);
    type(answerBox("pick-db"), "SQLite");
    fireEvent.submit(answerBox("pick-db").form as HTMLFormElement);
    await waitFor(() => expect(view.rpcCalls).toHaveLength(1));
    await waitFor(() => expect(answerBox("pick-db").value).toBe(""));
    cleanup();

    renderBoard([backlogCard("pick-db")]);
    expect(answerBox("pick-db").value).toBe("");
  });

  it("clears it when the send lands after the board has gone", async () => {
    let land: (value: null) => void = () => undefined;
    renderBoard([backlogCard("pick-db")], { "mate.ask": () => new Promise<null>((resolve) => (land = resolve)) });
    type(answerBox("pick-db"), "SQLite");
    fireEvent.submit(answerBox("pick-db").form as HTMLFormElement);
    cleanup();
    await act(async () => land(null));

    renderBoard([backlogCard("pick-db")]);
    expect(answerBox("pick-db").value).toBe("");
  });

  it("keeps the words when the send fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderBoard([backlogCard("pick-db")], { "mate.ask": () => Promise.reject(new Error("offline")) });
    type(answerBox("pick-db"), "SQLite");
    fireEvent.submit(answerBox("pick-db").form as HTMLFormElement);
    await waitFor(() => expect(view.rpcCalls).toHaveLength(1));
    await waitFor(() => expect(answerBox("pick-db").disabled).toBe(false));
    cleanup();

    renderBoard([backlogCard("pick-db")]);
    expect(answerBox("pick-db").value).toBe("SQLite");
  });

  it("drops the words of a card that has left the board", () => {
    renderBoard([backlogCard("pick-db"), backlogCard("pick-ui")]);
    type(answerBox("pick-db"), "SQLite");
    type(answerBox("pick-ui"), "Tabs");
    cleanup();

    renderBoard([backlogCard("pick-ui")]);
    cleanup();
    renderBoard([backlogCard("pick-db"), backlogCard("pick-ui")]);
    expect(answerBox("pick-db").value).toBe("");
    expect(answerBox("pick-ui").value).toBe("Tabs");
  });

  it("still works when the browser's storage refuses the drafts", () => {
    const { getItem, setItem } = Storage.prototype;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === DRAFTS_KEY) throw new Error("blocked");
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === DRAFTS_KEY) throw new DOMException("full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    renderBoard([backlogCard("pick-db")]);
    type(answerBox("pick-db"), "SQLite");
    expect(answerBox("pick-db").value).toBe("SQLite");
  });
});

describe("a worker card's Steer and Relaunch lines across a thread switch", () => {
  it("reopens the line that was being written, with its words", () => {
    renderBoard([workerCard("thr_w")]);
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    type(screen.getByPlaceholderText(/What the new worker should know/), "Skip the flaky test");
    cleanup();

    renderBoard([workerCard("thr_w")]);
    expect((screen.getByPlaceholderText(/What the new worker should know/) as HTMLTextAreaElement).value).toBe("Skip the flaky test");
  });

  it("forgets the line on Cancel", () => {
    renderBoard([workerCard("thr_w")]);
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    type(screen.getByPlaceholderText(/Tell the worker/), "Rebase first");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    cleanup();

    renderBoard([workerCard("thr_w")]);
    expect(screen.queryByPlaceholderText(/Tell the worker/)).toBeNull();
  });

  it("forgets the line once it is sent", async () => {
    const view = renderBoard([workerCard("thr_w")], { "crew.steer": () => ({}) });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    type(screen.getByPlaceholderText(/Tell the worker/), "Rebase first");
    const sends = screen.getAllByRole("button", { name: "Send" }) as HTMLButtonElement[];
    fireEvent.click(sends.find((button) => button.closest("form") === null) as HTMLButtonElement);
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "crew.steer")).toBe(true));
    await waitFor(() => expect(screen.queryByPlaceholderText(/Tell the worker/)).toBeNull());
    cleanup();

    renderBoard([workerCard("thr_w")]);
    expect(screen.queryByPlaceholderText(/Tell the worker/)).toBeNull();
  });
});

describe("a worker's Note across a thread switch", () => {
  function renderCrewPanel(rpc: Record<string, () => unknown> = {}) {
    return renderSlot(
      { component: CrewPanel },
      { card: workerCard("thr_w"), threadId: "thr_w", mateThreadId: "thr_mate", onChanged: () => undefined },
      { rpc: { "mate.ask": () => null, ...rpc } },
    );
  }
  const note = () => screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;

  it("keeps the note until it is saved", async () => {
    renderCrewPanel();
    type(note(), "It owns the migration");
    cleanup();

    const view = renderCrewPanel({ "crew.note": () => ({}) });
    expect(note().value).toBe("It owns the migration");
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "crew.note")).toBe(true));
    await waitFor(() => expect(note().value).toBe(""));
    cleanup();

    renderCrewPanel();
    expect(note().value).toBe("");
  });
});

describe("the drafts store", () => {
  it("drops words older than a week, and unreadable entries", () => {
    const storage = window.localStorage;
    writeDraft(storage, "old", "answer", { text: "stale" }, 1_000);
    writeDraft(storage, "new", "answer", { text: "fresh" }, 1_000 + DRAFT_KEEP_MS);
    expect(readDraft(storage, "old", "answer", 2_000 + DRAFT_KEEP_MS)).toBeNull();
    expect(readDraft(storage, "new", "answer", 2_000 + DRAFT_KEEP_MS)?.text).toBe("fresh");

    pruneDrafts(storage, null, 2_000 + DRAFT_KEEP_MS);
    expect(Object.keys(JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}"))).toEqual(["new"]);

    storage.setItem(DRAFTS_KEY, "{not json");
    expect(readDraft(storage, "new", "answer")).toBeNull();
    writeDraft(storage, "again", "answer", { text: "works" });
    expect(readDraft(storage, "again", "answer")?.text).toBe("works");
  });

  it("removes a card's entry when its last line is emptied", () => {
    const storage = window.localStorage;
    writeDraft(storage, "pick-db", "answer", { text: "SQLite" });
    writeDraft(storage, "pick-db", "answer", null);
    expect(storage.getItem(DRAFTS_KEY)).toBe("{}");
  });
});
