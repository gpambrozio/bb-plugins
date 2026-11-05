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
import type { CardPayload } from "../shared/types";
import { ExerciseCard } from "./card";
import { DRAFT_SAVE_DELAY_MS } from "./draft";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(cleanup);

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
    cardDraft: (input: { sessionId: string; ordinal: number }) => api.cardDraft(input),
    saveDraft: (input: { sessionId: string; ordinal: number; draft: never }) => {
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
