// @vitest-environment jsdom
/**
 * The app against recorded RPC handlers: what it registers, the banner's seen accounting and answers,
 * the card's submissions, the Learning tab, and the thread menu's choice.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract, type RpcContract } from "../shared/contract";
import type { CardPayload, Offer, Session, ThreadView } from "../shared/types";
import { OfferBanner } from "./banner";
import { ExerciseCard } from "./card";
import { SettledRow } from "./settled-row";
import { LearningTab, useLearningTabVisible } from "./tab";
import { offersItem } from "./thread-action";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(cleanup);

const WORK = "thr_work";

function sidebarThread(overrides: Record<string, unknown> = {}) {
  return {
    id: WORK,
    projectId: "proj_1",
    title: "Add median",
    titleFallback: null,
    displayTitle: "Add median",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    originPluginId: null,
    originKind: null,
    sourceThreadId: null,
    status: "idle",
    hasPendingInteraction: false,
    ...overrides,
  } as never;
}

const offer: Offer = { id: "off_1", threadId: WORK, trigger: "commit", topic: '"Add median"', refs: {}, createdAt: 1, seenAt: null };

function view(overrides: Partial<ThreadView> = {}): ThreadView {
  return {
    eligible: true,
    offer,
    hosted: null,
    started: null,
    offersOn: true,
    projectKey: "remote:github.com/acme/calc",
    projectName: "calc",
    projectNever: false,
    offersOffGlobally: false,
    sessionWhere: "fork",
    ...overrides,
  };
}

const session: Session = {
  id: "ses_1",
  mode: "fork",
  state: "paused",
  topic: '"Add median"',
  trigger: "commit",
  sourceThreadId: WORK,
  threadId: "thr_fork",
  pauseReason: "you paused it",
  summary: null,
  createdAt: 1,
  updatedAt: 2,
  finishedAt: null,
  asked: 2,
  answered: 1,
};

type Handlers = Partial<Record<keyof RpcContract, (input: never) => unknown>>;

function handlers(current: () => ThreadView, extra: Handlers = {}) {
  return {
    threadView: () => current(),
    projectSessions: () => ({ paused: [], previous: [], hasMore: false }),
    sessionDetail: () => ({ session, exercises: [] }),
    topicChoices: () => ({ choices: [{ id: "commit", label: 'The last commit: "Add median"', topic: '"Add median"', trigger: "manual", refs: {} }] }),
    offerSeen: () => null,
    answerOffer: () => ({ threadId: "thr_fork" }),
    startSession: () => ({ threadId: "thr_fork" }),
    pauseSession: () => null,
    resumeSession: () => ({ threadId: "thr_fork" }),
    finishSession: () => null,
    deleteSession: () => null,
    threadOffers: () => ({ off: [] }),
    setThreadOffers: () => null,
    setProjectNever: () => null,
    neverProjects: () => ({ projects: [] }),
    removeNeverProject: () => null,
    ...extra,
  } as never;
}

describe("registrations", () => {
  it("registers the banner, the card, its settled row, the fixed tab, the thread menu and the settings section", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.composerCustomizations.map((custom) => [custom.id, custom.scopes, custom.banners?.map((banner) => banner.id)])).toEqual([["offer", ["thread"], ["offer"]]]);
    expect(app.pendingInteractions.map((slot) => slot.id)).toEqual(["exercise"]);
    expect(app.timelineRenderers.map((slot) => slot.kind)).toEqual(["learning-exercises/exercise"]);
    expect(app.tabs.map((tab) => [tab.id, tab.context.kind, tab.availability, tab.icon, tab.title])).toEqual([["learning", "thread", "fixed", "Brain", "Learning"]]);
    expect(app.threadActions.map((action) => action.id)).toEqual(["offers"]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["never-projects"]);
  });
});

describe("the banner", () => {
  const render = (rpc: object, thread = sidebarThread()) =>
    renderSlot<object, RpcContract>({ component: OfferBanner }, {}, {
      rpc: rpc as never,
      experimental_rpcContract: rpcContract,
      composer: { scope: { kind: "thread", threadId: WORK } },
      sidebarThreads: { status: "ready", threads: [thread] },
    });

  it("shows an idle thread's offer and reports it seen once", async () => {
    const slot = render(handlers(() => view()));
    await screen.findByText(/You just committed "Add median"\./);
    await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "offerSeen")).toEqual([expect.objectContaining({ input: { offerId: "off_1" } })]));
    expect(screen.getByText(/It runs in a side thread/)).toBeTruthy();
  });

  it("shows nothing while a turn runs, and nothing without an offer", async () => {
    const busy = render(handlers(() => view()), sidebarThread({ status: "active" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/You just committed/)).toBeNull();
    expect(busy.rpcCalls.filter((call) => call.method === "offerSeen")).toEqual([]);
    cleanup();
    render(handlers(() => view({ offer: null })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/Learning:/)).toBeNull();
  });

  it("Start answers the offer and opens the session thread", async () => {
    const slot = render(handlers(() => view()));
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(slot.navigateCalls).toEqual([expect.objectContaining({ method: "toThread", threadId: "thr_fork" })]));
    expect(slot.rpcCalls.find((call) => call.method === "answerOffer")?.input).toEqual({ offerId: "off_1", answer: "start" });
  });

  it("More offers Run here and Never for this project; a provider that cannot fork says so", async () => {
    const slot = render(handlers(() => view({ sessionWhere: "here" })));
    await screen.findByText(/It runs here, in this thread\./);
    fireEvent.click(screen.getByRole("button", { name: "More choices" }));
    expect(screen.queryByRole("button", { name: "Run it in this thread" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Never for this project" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "answerOffer")?.input).toEqual({ offerId: "off_1", answer: "never-project" }));
  });
});

describe("the exercise card", () => {
  const payload: CardPayload = { sessionId: "ses_1", ordinal: 2, type: "prediction", question: "What does `median([])` do?", files: ["calc.py"], environmentId: "env_1", topic: '"Add median"', maxQuestions: 8 };

  function renderCard() {
    const submit = vi.fn(async () => {});
    renderSlot({ component: ExerciseCard }, { interaction: { id: "pint_1", threadId: "thr_fork", title: "Question 2", payload, createdAt: 1, expiresAt: null }, submit, cancel: vi.fn(async () => {}) });
    return submit;
  }

  it("needs an answer and a confidence before Submit", () => {
    const submit = renderCard();
    expect(screen.getByText("Question 2 of at most 8")).toBeTruthy();
    const send = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "  It raises ValueError  " } });
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "4 · Sure" }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(submit).toHaveBeenCalledWith({ action: "answer", answer: "It raises ValueError", confidence: 4 });
  });

  it.each([
    ["Skip", { action: "skip" }],
    ["Make it more specific", { action: "more-specific" }],
    ["Pause session", { action: "pause" }],
  ])("%s submits %o", (label, value) => {
    const submit = renderCard();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(submit).toHaveBeenCalledWith(value);
  });

  it("caps the answer at the limit and says so (review finding 8)", () => {
    renderCard();
    const box = screen.getByLabelText("Your answer") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(20_000);
    fireEvent.change(box, { target: { value: "x".repeat(20_000) } });
    expect(screen.getByRole("status").textContent).toContain("Answers stop here");
  });

  it("every button is a plain button, so none submits bb's composer form", () => {
    renderCard();
    for (const button of screen.getAllByRole("button")) expect(button.getAttribute("type")).toBe("button");
  });
});

describe("the settled row", () => {
  it("shows the question and the learner's own words with their confidence", () => {
    renderSlot({ component: SettledRow }, {
      row: { id: "r", threadId: "t", turnId: null, kind: "learning-exercises/exercise", toolName: null, status: "completed", startedAt: 1, completedAt: 2 },
      payload: { question: "Q?", action: "answer", answer: "My answer", confidence: 2 },
      presentation: null,
      thread: { id: "t", providerId: null },
      Original: () => <span>original</span>,
    } as never);
    expect(screen.getByText("My answer")).toBeTruthy();
    expect(screen.getByText("Confidence 2/5 · Unsure")).toBeTruthy();
  });
});

describe("the Learning tab", () => {
  const render = (rpc: object, thread = sidebarThread()) =>
    renderSlot({ component: LearningTab }, { threadId: WORK, environment: null }, {
      rpc: rpc as never,
      experimental_rpcContract: rpcContract,
      sidebarThreads: { status: "ready", threads: [thread] },
    });

  it("shows the offer, a topic picker from data, and the footer controls", async () => {
    const slot = render(handlers(() => view()));
    await screen.findByText(/You just committed/);
    expect(await screen.findByText('The last commit: Add median')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start in a side thread" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "startSession")?.input).toEqual({ threadId: WORK, topic: '"Add median"', trigger: "manual", refs: {}, here: false }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Offers in this thread" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "setThreadOffers")?.input).toEqual({ threadId: WORK, on: false }));
  });

  it("starts on a typed topic", async () => {
    const slot = render(handlers(() => view({ offer: null }), { topicChoices: () => ({ choices: [] }) }));
    fireEvent.change(await screen.findByLabelText("Your own topic"), { target: { value: "How retries back off" } });
    fireEvent.click(screen.getByRole("button", { name: "Start in a side thread" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "startSession")?.input).toMatchObject({ topic: "How retries back off", trigger: "manual" }));
  });

  it("an open session replaces Start with its controls; Resume opens its thread", async () => {
    const slot = render(handlers(() => view({ offer: null, started: session })));
    await screen.findByText("Session from this thread");
    expect(screen.queryByText("Start an exercise")).toBeNull();
    expect(screen.getByText(/Paused · 1 of 2 answered · side thread · you paused it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(slot.navigateCalls).toEqual([expect.objectContaining({ method: "toThread", threadId: "thr_fork" })]));
  });

  it("lists paused and previous sessions; Delete asks once more", async () => {
    const finished = { ...session, id: "ses_2", state: "finished" as const, summary: "Covered median.", pauseReason: null, finishedAt: 3 };
    const slot = render(handlers(() => view({ offer: null }), { projectSessions: () => ({ paused: [session], previous: [finished], hasMore: false }) }));
    await screen.findByText("Paused");
    fireEvent.click(screen.getAllByRole("button", { expanded: false }).find((button) => button.textContent?.includes("finished") || button.textContent?.includes("Add median"))!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete it and its answers" }));
    await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "deleteSession")).toBe(true));
  });

  it("says when the project is on the never list, with Undo", async () => {
    const slot = render(handlers(() => view({ offer: null, projectNever: true })));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "setProjectNever")?.input).toEqual({ threadId: WORK, never: false }));
  });
});

describe("where the tab shows", () => {
  function Probe(props: { threadId: string }) {
    return <span>{useLearningTabVisible({ threadId: props.threadId, environment: null }) ? "visible" : "hidden"}</span>;
  }

  it.each([
    ["a top-level thread", {}, "visible"],
    ["a session thread of this plugin", { originPluginId: "learning-exercises" }, "visible"],
    ["a child thread", { parentThreadId: "thr_parent" }, "hidden"],
    ["another plugin's thread", { originPluginId: "automations" }, "hidden"],
    ["a delegated thread", { lifecycleOwnerThreadId: "thr_owner" }, "hidden"],
  ])("%s: %s", (_name, overrides, expected) => {
    renderSlot({ component: Probe }, { threadId: WORK }, { sidebarThreads: { status: "ready", threads: [sidebarThread(overrides)] } });
    expect(screen.getByText(expected)).toBeTruthy();
  });
});

describe("the thread menu", () => {
  const target = { id: WORK, projectId: "proj_1", parentThreadId: null, parentNotifications: "auto", archivedAt: null, pinnedAt: null, sectionId: null, isUnread: false, status: "idle", environment: null } as never;

  it("shows On or Off and saves a pick", async () => {
    const set = vi.fn(async () => {});
    const item = offersItem({ thread: target, data: { off: new Set([WORK]), set }, sdk: {} as never, navigate: {} as never } as never)!;
    expect(item.detail).toBe("Off");
    expect(item.choices?.items.map((choice) => [choice.id, choice.selected])).toEqual([
      ["on", false],
      ["off", true],
    ]);
    await item.run({ value: "on" } as never);
    expect(set).toHaveBeenCalledWith(WORK, true);
  });

  it("stays out of child and archived threads", () => {
    const data = { off: new Set<string>(), set: vi.fn() };
    expect(offersItem({ thread: { ...(target as object), parentThreadId: "thr_p" }, data } as never)).toBeNull();
    expect(offersItem({ thread: { ...(target as object), archivedAt: 5 }, data } as never)).toBeNull();
  });
});
