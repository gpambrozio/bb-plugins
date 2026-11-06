// @vitest-environment jsdom
/**
 * Unsent answers survive the card going away (the user switched threads, and came back): the card saves
 * as the learner types, and a card mounted again restores it. The RPCs are served by the real session
 * service over an in-memory store, so the server's reading of a draft against the form is in the loop.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LearningApi } from "../server/api";
import { OfferEngine } from "../server/offers";
import { SessionService } from "../server/sessions";
import { FakePorts, flush, thread } from "../server/testing/fake-ports";
import { EVERY_KIND } from "../server/testing/forms";
import { memoryStore, settingsWith } from "../server/testing/store";
import { rpcContract } from "../shared/contract";
import type { CardPayload, Session, ThreadView } from "../shared/types";
import { ExerciseCard } from "./card";
import { DRAFT_KEEP_MS, DRAFT_SAVE_DELAY_MS, draftStorageKey, sweepDrafts, writerId } from "./draft";
import { LearningTab } from "./tab";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** A session waiting on question 1, asked with `form` (or none), and the RPCs the card calls. */
async function server(form?: unknown) {
  const ports = new FakePorts();
  ports.threads.set("thr_work", thread({ id: "thr_work" }));
  const store = memoryStore();
  const settings = () => settingsWith();
  const sessions = new SessionService(ports, store, settings);
  const api = new LearningApi({ ports, store, offers: new OfferEngine({ ports, store, settings }), sessions, settings });
  const { threadId, sessionId } = await sessions.start({ sourceThreadId: "thr_work", topic: "t", trigger: "manual", refs: {}, offerId: null });
  void sessions.ask(threadId, { type: "prediction", question: "Read `calc.py:12`.", files: [], form }, "tool");
  await flush();
  const payload = ports.cards[0]!.request.payload;
  const saves: unknown[] = [];
  const rpc = {
    openQuestions: (input: { questions: { sessionId: string; ordinal: number }[] }) => api.openQuestions(input),
    cardDraft: (input: { sessionId: string; ordinal: number }) => api.cardDraft(input),
    saveDraft: (input: { sessionId: string; ordinal: number; draft: never; writer: string }) => {
      saves.push(input.draft);
      return api.saveDraft(input);
    },
  };
  return { ports, store, sessions, sessionId, payload, rpc, saves };
}

function mount(payload: CardPayload, rpc: object) {
  const submit = vi.fn(async () => {});
  renderSlot({ component: ExerciseCard }, { interaction: { id: "pint_1", threadId: "thr_fork", title: "Question 1", payload, createdAt: 1, expiresAt: null }, submit, cancel: vi.fn(async () => {}) }, {
    rpc: rpc as never,
    experimental_rpcContract: rpcContract,
  });
  return submit;
}

const group = (name: string) => screen.getByRole("group", { name: new RegExp(`^${name.replace(/[?()[\]]/g, "\\$&")}`) });
const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const checked = (element: HTMLElement) => (element as HTMLInputElement).checked;

/** Some of `EVERY_KIND`, one control of each kind that keeps a value: a partly filled form. */
function fillSome() {
  fireEvent.change(screen.getByLabelText("Function name"), { target: { value: "median" } });
  fireEvent.change(screen.getByLabelText("Calls"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Risk"), { target: { value: "30" } });
  fireEvent.change(screen.getByLabelText(/^Your fix/), { target: { value: "return sorted(xs)[n // 2]" } });
  fireEvent.click(within(group("What happens?")).getByLabelText("It raises"));
  fireEvent.change(screen.getByLabelText("Which module?"), { target: { value: "stats" } });
  fireEvent.click(screen.getByLabelText("The tests"));
  fireEvent.click(within(group("Safe to call twice?")).getByLabelText("No"));
  fireEvent.click(within(group("How clear is the code?")).getByRole("radio", { name: "4" }));
  fireEvent.click(within(group("Order the steps")).getByRole("button", { name: "Keep this order" }));
  fireEvent.change(screen.getByLabelText("[]"), { target: { value: "error" } });
  fireEvent.change(screen.getByLabelText("Edge cases, entry 1"), { target: { value: "empty list" } });
  fireEvent.click(screen.getByLabelText("heapq, Stable"));
  fireEvent.change(screen.getByLabelText("sorted(), Grade"), { target: { value: "good" } });
  fireEvent.click(screen.getByRole("button", { name: "2 · Unsure" }));
}

function expectSome() {
  expect(value("Function name")).toBe("median");
  expect(value("Calls")).toBe("2");
  expect(value("Risk")).toBe("30");
  expect((screen.getByLabelText(/^Your fix/) as HTMLTextAreaElement).value).toBe("return sorted(xs)[n // 2]");
  expect(checked(within(group("What happens?")).getByLabelText("It raises"))).toBe(true);
  expect(value("Which module?")).toBe("stats");
  expect(checked(screen.getByLabelText("The tests"))).toBe(true);
  expect(checked(screen.getByLabelText("The CLI"))).toBe(false);
  expect(checked(within(group("Safe to call twice?")).getByLabelText("No"))).toBe(true);
  expect(checked(within(group("How clear is the code?")).getByRole("radio", { name: "4" }))).toBe(true);
  expect(within(group("Order the steps")).getByRole("button", { name: "Keep this order" }).getAttribute("aria-pressed")).toBe("true");
  expect(value("[]")).toBe("error");
  expect(value("[3]")).toBe("");
  expect(value("Edge cases, entry 1")).toBe("empty list");
  expect(checked(screen.getByLabelText("heapq, Stable"))).toBe(true);
  expect(value("sorted(), Grade")).toBe("good");
  expect(screen.getByRole("button", { name: "2 · Unsure" }).getAttribute("aria-pressed")).toBe("true");
}

describe("an unsent answer", () => {
  it("survives the card unmounting and mounting again, partly filled, every kind of control", async () => {
    const { payload, rpc, saves, store, sessionId } = await server(EVERY_KIND);
    mount(payload, rpc);
    fillSome();
    // Saved once the typing stops.
    await waitFor(() => expect(saves.length).toBeGreaterThan(0), { timeout: DRAFT_SAVE_DELAY_MS * 4 });
    expect(saves).toHaveLength(1);
    expect(store.draft(sessionId, 1)?.fields).toMatchObject({ name: "median", risk: 30, order: ["parse", "sort", "pick"], compare: { heap: { stable: true } } });

    // The user switches threads: the card goes. They come back: a new card restores it.
    cleanup();
    mount(payload, rpc);
    await waitFor(() => expect(value("Function name")).toBe("median"));
    expectSome();
  });

  it("is saved at once when the card goes before the wait is over", async () => {
    const { payload, rpc, saves } = await server(EVERY_KIND);
    mount(payload, rpc);
    fireEvent.change(screen.getByLabelText("Function name"), { target: { value: "med" } });
    expect(saves).toHaveLength(0);
    cleanup();
    await waitFor(() => expect(saves).toHaveLength(1));
    mount(payload, rpc);
    await waitFor(() => expect(value("Function name")).toBe("med"));
  });

  it("keeps the text box and the confidence of a question without a form", async () => {
    const { payload, rpc } = await server();
    mount(payload, rpc);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "It raises ValueError" } });
    fireEvent.click(screen.getByRole("button", { name: "4 · Sure" }));
    cleanup();
    mount(payload, rpc);
    await waitFor(() => expect(value("Your answer")).toBe("It raises ValueError"));
    expect(screen.getByRole("button", { name: "4 · Sure" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not overwrite what the learner typed before the draft arrived", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    sessions.saveDraft(sessionId, 1, { answer: "old draft" });
    let release: () => void = () => {};
    const slow = { ...rpc, cardDraft: (input: { sessionId: string; ordinal: number }) => new Promise((resolve) => (release = () => resolve(rpc.cardDraft(input)))) };
    mount(payload, slow);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "new words" } });
    release();
    await flush();
    expect(value("Your answer")).toBe("new words");
  });

  it("is no longer saved once the answer is sent, and a pause saves it first", async () => {
    const { payload, rpc, saves } = await server();
    const submit = mount(payload, rpc);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "3 · Fairly sure" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalled();
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, DRAFT_SAVE_DELAY_MS + 50));
    expect(saves).toHaveLength(0);

    mount(payload, rpc);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "half an answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause session" }));
    await waitFor(() => expect(saves).toEqual([{ answer: "half an answer", confidence: null }]));
  });
});

/**
 * The saves as the network delivers them: each one waits in `queue` until the test delivers it (it then
 * reaches the server) or drops it (the request dies, as on an unload). `mode` "auto" delivers at once.
 */
function network(rpc: { cardDraft: (input: { sessionId: string; ordinal: number }) => unknown; saveDraft: (input: { sessionId: string; ordinal: number; draft: never; writer: string }) => unknown }) {
  const queue: { draft: { answer?: string }; deliver: () => void; drop: () => void; commitAndLose: () => void }[] = [];
  const net = { mode: "hold" as "hold" | "auto" | "fail", queue, slowRead: null as null | (() => void) };
  const wrapped = {
    cardDraft: (input: { sessionId: string; ordinal: number }) => {
      if (net.slowRead === null) return rpc.cardDraft(input);
      // The server answers now; the answer arrives when the test releases it.
      const answer = rpc.cardDraft(input);
      return new Promise((resolve) => (net.slowRead = () => resolve(answer)));
    },
    saveDraft: (input: { sessionId: string; ordinal: number; draft: never; writer: string }) => {
      if (net.mode === "auto") return rpc.saveDraft(input);
      if (net.mode === "fail") return Promise.reject(new Error("request killed"));
      return new Promise((resolve, reject) => {
        queue.push({
          draft: input.draft,
          deliver: () => resolve(rpc.saveDraft(input)),
          drop: () => reject(new Error("request killed")),
          // The save lands on the server, and its answer is lost on the way back.
          commitAndLose: () => {
            rpc.saveDraft(input);
            reject(new Error("connection reset"));
          },
        });
      });
    },
    openQuestions: (input: { questions: { sessionId: string; ordinal: number }[] }) => (rpc as unknown as { openQuestions: (i: typeof input) => unknown }).openQuestions(input),
  };
  return { net, wrapped };
}

const typeAnswer = (text: string) => fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: text } });
const backup = (sessionId: string, ordinal = 1) => {
  const text = window.localStorage.getItem(draftStorageKey(sessionId, ordinal));
  return text === null ? null : (JSON.parse(text) as { mount: string; at: number; draft: { answer?: string } });
};

describe("an unsent answer, when the network and the page misbehave (review passes 1 and 2 of the drafts)", () => {
  it("one question's saves go one at a time, and only the latest waiting edit goes next", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    const { net, wrapped } = network(rpc);
    mount(payload, wrapped);
    typeAnswer("one");
    await waitFor(() => expect(net.queue).toHaveLength(1), { timeout: DRAFT_SAVE_DELAY_MS * 4 });
    typeAnswer("one two");
    await new Promise((resolve) => setTimeout(resolve, DRAFT_SAVE_DELAY_MS + 50));
    typeAnswer("one two three");
    // The learner switches threads: the newest edit waits behind the save in flight; "one two" never goes.
    cleanup();
    await flush();
    expect(net.queue).toHaveLength(1);
    net.queue[0]!.deliver();
    await waitFor(() => expect(net.queue).toHaveLength(2));
    expect(net.queue[1]!.draft.answer).toBe("one two three");
    net.queue[1]!.deliver();
    await waitFor(() => expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("one two three"));
    await waitFor(() => expect(backup(sessionId)).toBeNull());
    net.mode = "auto";
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("one two three"));
  });

  it("an old card's late confirmation never removes a newer card's backup", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    const { net, wrapped } = network(rpc);
    mount(payload, wrapped);
    typeAnswer("A");
    cleanup();
    await waitFor(() => expect(net.queue).toHaveLength(1));
    // Back while A is still on its way: the backup brings A back; the learner goes on.
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("A"));
    typeAnswer("A, then B");
    expect(backup(sessionId)?.draft.answer).toBe("A, then B");
    // A's confirmation arrives for the old card, then for the new card's resend of A: B's backup stays.
    net.queue[0]!.deliver();
    await waitFor(() => expect(net.queue).toHaveLength(2));
    expect(net.queue[1]!.draft.answer).toBe("A");
    expect(backup(sessionId)?.draft.answer).toBe("A, then B");
    cleanup();
    net.queue[1]!.deliver();
    await flush();
    expect(backup(sessionId)?.draft.answer).toBe("A, then B");
    // B goes next, and its own confirmation removes it.
    await waitFor(() => expect(net.queue.at(-1)?.draft.answer).toBe("A, then B"));
    net.queue.at(-1)!.deliver();
    await waitFor(() => expect(backup(sessionId)).toBeNull());
    expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("A, then B");
  });

  it("an edit made before the server's draft arrives wins over it, and keeps its backup", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    sessions.saveDraft(sessionId, 1, { answer: "from the server" });
    const { net, wrapped } = network(rpc);
    net.slowRead = () => {};
    mount(payload, wrapped);
    typeAnswer("typed at once");
    net.slowRead();
    await flush();
    expect(value("Your answer")).toBe("typed at once");
    expect(backup(sessionId)?.draft.answer).toBe("typed at once");
  });

  it("a backup built on the server's current draft is restored and sent again; the next edit outlives that save", async () => {
    const { payload, rpc, sessions, sessionId, store } = await server();
    sessions.saveDraft(sessionId, 1, { answer: "on the server" });
    const base = store.draftToken(sessionId, 1);
    window.localStorage.setItem(draftStorageKey(sessionId, 1), JSON.stringify({ mount: "an-earlier-page", at: Date.now(), base, draft: { answer: "kept in this browser" } }));
    const { net, wrapped } = network(rpc);
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("kept in this browser"));
    await waitFor(() => expect(net.queue).toHaveLength(1));
    typeAnswer("kept in this browser, and more");
    // The backup's own save is confirmed: the newer edit's backup stays, now built on that save.
    net.queue[0]!.deliver();
    await flush();
    expect(value("Your answer")).toBe("kept in this browser, and more");
    expect(backup(sessionId)?.draft.answer).toBe("kept in this browser, and more");
  });

  it("a stale backup on one device does not overwrite what another device saved later (review pass 3, finding 7)", async () => {
    const { payload, rpc, sessions, sessionId, store, saves } = await server();
    // Device A typed, saw its draft confirmed at token T0, typed more, and the page died before saving.
    sessions.saveDraft(sessionId, 1, { answer: "device A, saved" }, writerId());
    const t0 = store.draftToken(sessionId, 1);
    window.localStorage.setItem(draftStorageKey(sessionId, 1), JSON.stringify({ mount: "device-a", at: Date.now(), base: t0, draft: { answer: "device A, never sent" } }));
    // Later, device B answers further and saves.
    sessions.saveDraft(sessionId, 1, { answer: "device B, later" }, "device-b");
    expect(store.draftToken(sessionId, 1)).toBeGreaterThan(t0!);
    // Opening the card again on device A: the server moved on, so its draft wins and A's backup goes.
    mount(payload, rpc);
    await waitFor(() => expect(value("Your answer")).toBe("device B, later"));
    expect(backup(sessionId)).toBeNull();
    await flush();
    expect(saves).toEqual([]);
    expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("device B, later");
  });

  it("a backup too old to keep is never restored or sent (review pass 3, finding 8)", async () => {
    const { payload, rpc, sessionId, saves } = await server();
    window.localStorage.setItem(draftStorageKey(sessionId, 1), JSON.stringify({ mount: "m", at: Date.now() - DRAFT_KEEP_MS - 1, base: null, draft: { answer: "expired" } }));
    mount(payload, rpc);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(value("Your answer")).toBe("");
    expect(backup(sessionId)).toBeNull();
    expect(saves).toEqual([]);
  });

  it("nor is a backup past the newest 20", async () => {
    const { payload, rpc, sessionId, saves } = await server();
    const now = Date.now();
    window.localStorage.setItem(draftStorageKey(sessionId, 1), JSON.stringify({ mount: "m", at: now - 60_000, base: null, draft: { answer: "the oldest" } }));
    for (let index = 0; index < 20; index += 1) window.localStorage.setItem(draftStorageKey(`ses_${index}`, 1), JSON.stringify({ mount: "m", at: now - index, base: null, draft: { answer: "x" } }));
    mount(payload, rpc);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(value("Your answer")).toBe("");
    expect(backup(sessionId)).toBeNull();
    expect(saves).toEqual([]);
  });

  it("an own save that landed with its answer lost does not cost the newer edit after a reload (finding 9)", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    const { net, wrapped } = network(rpc);
    mount(payload, wrapped);
    typeAnswer("A");
    await waitFor(() => expect(net.queue).toHaveLength(1), { timeout: DRAFT_SAVE_DELAY_MS * 4 });
    typeAnswer("A then B");
    // A reaches the server, its answer is lost; the page closes and B's save dies with it.
    net.queue[0]!.commitAndLose();
    cleanup();
    await waitFor(() => expect(net.queue).toHaveLength(2));
    net.queue[1]!.drop();
    await flush();
    expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("A");
    // The page loads again: the server's draft is this browser's own, so the backup is newer.
    net.mode = "auto";
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("A then B"));
    await waitFor(() => expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("A then B"));
  });

  it("a save in flight, a queued save and a third edit all survive a reload (finding 10)", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    const { net, wrapped } = network(rpc);
    mount(payload, wrapped);
    typeAnswer("A");
    await waitFor(() => expect(net.queue).toHaveLength(1), { timeout: DRAFT_SAVE_DELAY_MS * 4 });
    typeAnswer("A B");
    // B waits behind A.
    await new Promise((resolve) => setTimeout(resolve, DRAFT_SAVE_DELAY_MS + 50));
    net.queue[0]!.deliver();
    await waitFor(() => expect(net.queue).toHaveLength(2));
    typeAnswer("A B C");
    // B lands with its answer lost, then the page closes before C is saved.
    net.queue[1]!.commitAndLose();
    cleanup();
    await waitFor(() => expect(net.queue).toHaveLength(3));
    net.queue[2]!.drop();
    await flush();
    expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("A B");
    net.mode = "auto";
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("A B C"));
  });

  it("a first read answered before an own save, and delivered after it, does not cost the next edit (finding 11)", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    const { net, wrapped } = network(rpc);
    net.slowRead = () => {};
    // The read is answered now (no draft), and its answer held back.
    mount(payload, wrapped);
    typeAnswer("A");
    await waitFor(() => expect(net.queue).toHaveLength(1), { timeout: DRAFT_SAVE_DELAY_MS * 4 });
    net.queue[0]!.deliver();
    await flush();
    typeAnswer("A B");
    // The old answer arrives now; then the page closes before B is saved.
    net.slowRead();
    await flush();
    cleanup();
    await waitFor(() => expect(net.queue).toHaveLength(2));
    net.queue[1]!.drop();
    await flush();
    expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("A");
    net.slowRead = null;
    net.mode = "auto";
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("A B"));
  });

  it("a backup over another browser's draft it had read wins: the token is the one it was built on", async () => {
    const { payload, rpc, sessions, sessionId, store } = await server();
    sessions.saveDraft(sessionId, 1, { answer: "device B's draft" }, "device-b");
    const { net, wrapped } = network(rpc);
    net.mode = "auto";
    // This browser read device B's draft, then typed, and the page died before the save.
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("device B's draft"));
    net.mode = "fail";
    typeAnswer("device B's draft, edited here");
    window.dispatchEvent(new Event("pagehide"));
    cleanup();
    await flush();
    expect(backup(sessionId)).toMatchObject({ base: store.draftToken(sessionId, 1), draft: { answer: "device B's draft, edited here" } });
    net.mode = "auto";
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("device B's draft, edited here"));
    await waitFor(() => expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("device B's draft, edited here"));
  });

  it("saves at once when the page is hidden, before the wait is over", async () => {
    const { payload, rpc } = await server();
    const { net, wrapped } = network(rpc);
    mount(payload, wrapped);
    typeAnswer("then the app went to the background");
    expect(net.queue).toHaveLength(0);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockRestore();
    // At once, not after the wait.
    await flush();
    expect(net.queue).toHaveLength(1);
    expect(net.queue[0]!.draft.answer).toBe("then the app went to the background");
  });

  it("an unload that kills the save loses nothing: the next card restores the edit and saves it", async () => {
    const { payload, rpc, sessions, sessionId } = await server();
    const { net, wrapped } = network(rpc);
    net.mode = "fail";
    mount(payload, wrapped);
    typeAnswer("written just before closing");
    window.dispatchEvent(new Event("pagehide"));
    cleanup();
    await flush();
    expect(sessions.cardDraft(sessionId, 1)).toBeNull();
    expect(backup(sessionId)?.draft.answer).toBe("written just before closing");
    // The page loads again.
    net.mode = "auto";
    mount(payload, wrapped);
    await waitFor(() => expect(value("Your answer")).toBe("written just before closing"));
    await waitFor(() => expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("written just before closing"));
    await waitFor(() => expect(backup(sessionId)).toBeNull());
  });

  it.each(["Submit", "Skip"])("a %s that fails keeps the unsent edit and saves it", async (button) => {
    const { payload, rpc, sessions, sessionId } = await server();
    const { net, wrapped } = network(rpc);
    net.mode = "auto";
    const submit = vi.fn(async () => {
      throw new Error("offline");
    });
    renderSlot({ component: ExerciseCard }, { interaction: { id: "pint_1", threadId: "thr_fork", title: "Question 1", payload, createdAt: 1, expiresAt: null }, submit, cancel: vi.fn(async () => {}) }, {
      rpc: wrapped as never,
      experimental_rpcContract: rpcContract,
    });
    fireEvent.click(screen.getByRole("button", { name: "3 · Fairly sure" }));
    typeAnswer("my answer, sent too soon");
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    await waitFor(() => expect(sessions.cardDraft(sessionId, 1)?.answer).toBe("my answer, sent too soon"));
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("backups of closed questions (review pass 2 of the drafts, finding 6)", () => {
  const put = (key: string, at: number, answer = "x") => window.localStorage.setItem(key, JSON.stringify({ mount: "m", at, base: null, draft: { answer } }));
  // This browser's writer id is not a draft.
  const keys = () => Object.keys(window.localStorage).filter((key) => key !== "learning-exercises:writer").sort();

  it("a card's mount drops backups of closed questions and keeps its own", async () => {
    const { payload, rpc, sessionId } = await server();
    put(draftStorageKey(sessionId, 1), Date.now(), "mine");
    put(draftStorageKey("ses_finished", 3), Date.now());
    put(draftStorageKey(sessionId, 7), Date.now());
    window.localStorage.setItem("someone-else", "untouched");
    mount(payload, network(rpc).wrapped);
    await waitFor(() => expect(keys()).toEqual([draftStorageKey(sessionId, 1), "someone-else"].sort()));
    expect(value("Your answer")).toBe("mine");
  });

  it("drops backups older than a week, unreadable ones, and all but the newest 20, before asking the server", async () => {
    const now = Date.now();
    put(draftStorageKey("ses_old", 1), now - DRAFT_KEEP_MS - 1);
    window.localStorage.setItem(draftStorageKey("ses_bad", 1), "{not json");
    for (let index = 0; index < 25; index += 1) put(draftStorageKey(`ses_${index}`, 1), now - index * 1000);
    const asked: unknown[] = [];
    const call = (async (_method: string, input: { questions: { sessionId: string; ordinal: number }[] }) => {
      asked.push(...input.questions);
      return { open: input.questions };
    }) as never;
    await sweepDrafts(call, now);
    expect(asked).toHaveLength(20);
    expect(keys()).toEqual(Array.from({ length: 20 }, (_, index) => draftStorageKey(`ses_${index}`, 1)).sort());
  });

  it("keeps everything the server could not be asked about", async () => {
    put(draftStorageKey("ses_a", 1), Date.now());
    await sweepDrafts((async () => {
      throw new Error("offline");
    }) as never);
    expect(keys()).toEqual([draftStorageKey("ses_a", 1)]);
  });

  it("finishing or deleting a session in the Learning tab drops its backups at once", async () => {
    const { rpc } = await server();
    const hosted: Session = { id: "ses_mine", mode: "fork", state: "active", topic: "t", trigger: "manual", sourceThreadId: "thr_work", threadId: "thr_fork", pauseReason: null, summary: null, createdAt: 1, updatedAt: 2, finishedAt: null, asked: 2, answered: 1 };
    const finished: Session = { ...hosted, id: "ses_done", state: "finished", finishedAt: 3 };
    const view: ThreadView = { eligible: false, canStart: false, offer: null, hosted, started: null, offersOn: true, projectKey: "k", projectName: "calc", projectNever: false, offersOffGlobally: false, sessionWhere: "fork", workspace: null };
    put(draftStorageKey("ses_mine", 2), Date.now());
    put(draftStorageKey("ses_done", 1), Date.now());
    put(draftStorageKey("ses_other", 1), Date.now());
    renderSlot({ component: LearningTab }, { threadId: "thr_fork", environment: null }, {
      rpc: {
        threadView: () => view,
        projectSessions: () => ({ paused: [], previous: [finished], hasMore: false }),
        sessionDetail: () => ({ session: finished, exercises: [], workspace: null }),
        topicChoices: () => ({ choices: [] }),
        finishSession: () => null,
        deleteSession: () => null,
        // The sweep: everything is open as far as the server knows.
        openQuestions: (input: { questions: unknown[] }) => ({ open: input.questions }),
        saveDraft: rpc.saveDraft,
        cardDraft: rpc.cardDraft,
      } as never,
      experimental_rpcContract: rpcContract,
      sidebarThreads: { status: "ready", threads: [{ id: "thr_fork", projectId: "proj_1", title: "t", titleFallback: null, displayTitle: "t", parentThreadId: null, lifecycleOwnerThreadId: null, originPluginId: "learning-exercises", originKind: null, sourceThreadId: "thr_work", status: "idle", hasPendingInteraction: false }] } as never,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    await waitFor(() => expect(keys()).toEqual([draftStorageKey("ses_done", 1), draftStorageKey("ses_other", 1)].sort()));
    fireEvent.click(await screen.findByRole("button", { name: /Add median|^t/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete it and its answers" }));
    await waitFor(() => expect(keys()).toEqual([draftStorageKey("ses_other", 1)]));
  });
});
