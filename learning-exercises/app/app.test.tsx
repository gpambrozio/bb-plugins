// @vitest-environment jsdom
/**
 * The app against recorded RPC handlers: what it registers, the banner's seen accounting and answers,
 * the card's submissions, the Learning tab, and the thread menu's choice.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { experimental_FileLink as FileLink, type MarkdownProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract, type RpcContract } from "../shared/contract";
import type { CardPayload, Offer, Session, ThreadView } from "../shared/types";
import { OfferBanner } from "./banner";
import { ExerciseCard } from "./card";
import { FileRef, looksLikeFileRef, markdownDocument, parseFileRef, workspacePath } from "./file-refs";
import { SettledRow } from "./settled-row";
import { LEARNING_FIXED_TAB, LEARNING_ON_DEMAND_TAB, LearningOnDemandTab, LearningTab, useLearningOnDemandVisible, useLearningTabVisible, useOneLearningTab } from "./tab";
import { offersItem } from "./thread-action";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
// The harness's Markdown drops `experimental_document`; this one shows what bb would resolve links against.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    Markdown: (props: MarkdownProps) => (
      <div data-testid="bb-markdown" className={props.className} data-document={props.experimental_document === undefined ? "none" : JSON.stringify(props.experimental_document)}>
        {props.content}
      </div>
    ),
  };
});

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
    canStart: true,
    offer,
    hosted: null,
    started: null,
    offersOn: true,
    projectKey: "remote:github.com/acme/calc",
    projectName: "calc",
    projectNever: false,
    offersOffGlobally: false,
    sessionWhere: "fork",
    workspace: { threadId: WORK, environmentId: "env_1", rootPath: "/work/calc" },
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
    sessionDetail: () => ({ session, exercises: [], workspace: null }),
    topicChoices: () => ({ choices: [{ id: "commit", label: 'The last commit: "Add median"', topic: '"Add median"', trigger: "manual", refs: {} }] }),
    offerSeen: () => ({ visible: true }),
    answerOffer: () => ({ threadId: "thr_fork" }),
    startSession: () => ({ threadId: "thr_fork" }),
    pauseSession: () => null,
    resumeSession: () => ({ threadId: "thr_fork" }),
    finishSession: () => null,
    deleteSession: () => null,
    threadOffers: () => ({ off: [] }),
    setThreadOffers: () => null,
    setProjectNever: () => null,
    orientation: () => ({ current: null, live: null, last: null, canStart: true, cleaning: false }),
    neverProjects: () => ({ projects: [] }),
    removeNeverProject: () => null,
    ...extra,
  } as never;
}

describe("registrations", () => {
  it("registers the banner, the card, its settled row, the fixed and retired on-demand tabs, the thread menu and the settings section", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.composerCustomizations.map((custom) => [custom.id, custom.scopes, custom.banners?.map((banner) => banner.id)])).toEqual([["offer", ["thread"], ["offer"]]]);
    expect(app.pendingInteractions.map((slot) => slot.id)).toEqual(["exercise"]);
    expect(app.timelineRenderers.map((slot) => slot.kind)).toEqual(["learning-exercises/exercise"]);
    expect(app.tabs.map((tab) => [tab.id, tab.context.kind, tab.availability, tab.icon, tab.title])).toEqual([
      ["learning", "thread", "fixed", "Brain", "Learning"],
      ["learning-on-demand", "thread", "action", "Brain", "Learning"],
      ["orientation", "thread", "action", "FileText", "Walkthrough"],
    ]);
    // The retired on-demand tab stays registered only so instances an earlier build opened can close.
    expect(app.tabs.find((tab) => tab.id === LEARNING_ON_DEMAND_TAB.id)!.component).toBe(LearningOnDemandTab);
    expect(app.tabs.find((tab) => tab.id === LEARNING_FIXED_TAB.id)!.component).toBe(LearningTab);
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

  it("pads its content inside the banner's card chrome, which draws only the border", async () => {
    render(handlers(() => view()));
    const banner = await screen.findByTestId("offer-banner");
    expect(banner.className.split(" ")).toEqual(expect.arrayContaining(["px-3", "py-2.5"]));
  });

  it("draws an unseen offer only after the server grants its claim: two panes, delayed claims, one card (review pass 2)", async () => {
    const claims = new Map<string, (visible: boolean) => void>();
    const pane = (threadId: string, offerId: string) =>
      renderSlot<object, RpcContract>({ component: OfferBanner }, {}, {
        rpc: handlers(() => view({ offer: { ...offer, id: offerId, threadId, topic: `"${offerId}"` } }), {
          offerSeen: ({ offerId: claimed }: { offerId: string }) => new Promise((resolve) => claims.set(claimed, (visible) => resolve({ visible }))),
        } as never),
        experimental_rpcContract: rpcContract,
        composer: { scope: { kind: "thread", threadId } },
        sidebarThreads: { status: "ready", threads: [sidebarThread({ id: threadId })] },
      });
    pane("thr_a", "off_a");
    pane("thr_b", "off_b");
    await waitFor(() => expect([...claims.keys()].sort()).toEqual(["off_a", "off_b"]));
    // Both reads returned an offer, and both claims are pending: nothing is drawn yet.
    expect(screen.queryByText(/You just committed/)).toBeNull();
    claims.get("off_b")!(false);
    claims.get("off_a")!(true);
    await screen.findByText(/You just committed "off_a"\./);
    expect(screen.queryByText(/You just committed "off_b"/)).toBeNull();
  });

  it("draws an offer already seen at once, without claiming it again", async () => {
    const slot = render(handlers(() => view({ offer: { ...offer, seenAt: 5 } })));
    await screen.findByText(/You just committed "Add median"\./);
    expect(slot.rpcCalls.filter((call) => call.method === "offerSeen")).toEqual([]);
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

  it("in a sub-agent thread: no offer and no offer controls, but Start works with that thread as the source", async () => {
    const child = sidebarThread({ parentThreadId: "thr_mate" });
    const slot = render(handlers(() => view({ eligible: false, canStart: true, offer: null })), child);
    await screen.findByText("The last commit: Add median");
    fireEvent.click(await screen.findByRole("button", { name: "Start in a side thread" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "startSession")?.input).toMatchObject({ threadId: WORK, trigger: "manual" }));
    expect(screen.queryByRole("checkbox", { name: "Offers in this thread" })).toBeNull();
    expect(screen.queryByText(/You just committed/)).toBeNull();
  });

  it("offers no Start where the server says a session cannot start", async () => {
    render(handlers(() => view({ eligible: false, canStart: false, offer: null })));
    await screen.findByText("Previous");
    expect(screen.queryByText("Start an exercise")).toBeNull();
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
    ["a child (sub-agent) thread", { parentThreadId: "thr_parent" }, "visible"],
    ["a crew thread another plugin spawned", { parentThreadId: "thr_mate", originPluginId: "firstmate-crew" }, "visible"],
    ["another plugin's thread", { originPluginId: "automations" }, "visible"],
    ["a delegated thread", { lifecycleOwnerThreadId: "thr_owner" }, "visible"],
  ])("on the tab bar in %s", (_name, overrides, expected) => {
    renderSlot({ component: Probe }, { threadId: WORK }, { sidebarThreads: { status: "ready", threads: [sidebarThread(overrides)] } });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("not in a thread the sidebar does not list (a hidden thread)", () => {
    renderSlot({ component: Probe }, { threadId: "thr_hidden" }, { sidebarThreads: { status: "ready", threads: [sidebarThread()] } });
    expect(screen.getByText("hidden")).toBeTruthy();
  });

  it("never offers the retired on-demand tab in the launcher", () => {
    function Offered(props: { threadId: string }) {
      return <span>{useLearningOnDemandVisible({ threadId: props.threadId, environment: null }) ? "offered" : "not offered"}</span>;
    }
    for (const overrides of [{}, { parentThreadId: "thr_parent" }, { parentThreadId: "thr_mate", originPluginId: "firstmate-crew" }]) {
      renderSlot({ component: Offered }, { threadId: WORK }, { sidebarThreads: { status: "ready", threads: [sidebarThread(overrides)] } });
      expect(screen.getByText("not offered")).toBeTruthy();
      cleanup();
    }
  });
});

describe("one Learning tab per thread", () => {
  const onDemandOpen = (selected: boolean, panelOpen = true) => ({
    open: panelOpen,
    selectedKey: selected ? "tab-od" : "info",
    tabs: [
      { key: "info", title: "Info", status: null, closable: false, detail: { kind: "info" as const } },
      { key: "tab-od", title: "Learning", status: null, closable: true, detail: { kind: "plugin" as const, pluginId: "learning-exercises", tab: LEARNING_ON_DEMAND_TAB, params: null } },
    ],
  });
  const accept = { openTab: () => true, closeTab: () => true };

  function Probe(props: { thread: unknown }) {
    useOneLearningTab(props.thread as never);
    return <span>probe</span>;
  }

  it("closes a leftover on-demand tab in a sub-agent thread, and moves the selection to the fixed tab", () => {
    const child = sidebarThread({ parentThreadId: "thr_mate", originPluginId: "firstmate-crew" });
    const slot = renderSlot({ component: Probe }, { thread: child }, { experimental_panel: accept, experimental_panelTabs: onDemandOpen(true) });
    expect(slot.experimental_panelCalls).toEqual([
      { method: "openTab", options: { tab: LEARNING_FIXED_TAB } },
      { method: "closeTab", key: "tab-od" },
    ]);
  });

  it("waits while the thread's row is not known", () => {
    const slot = renderSlot({ component: Probe }, { thread: undefined }, { experimental_panel: accept, experimental_panelTabs: onDemandOpen(true) });
    expect(slot.experimental_panelCalls).toEqual([]);
    slot.rerender(<Probe thread={sidebarThread({ parentThreadId: "thr_parent" })} />);
    expect(slot.experimental_panelCalls.map((call) => call.method)).toEqual(["openTab", "closeTab"]);
  });

  it("closes an unselected or hidden-panel instance without opening anything", () => {
    for (const tabs of [onDemandOpen(false), onDemandOpen(true, false)]) {
      const slot = renderSlot({ component: Probe }, { thread: sidebarThread() }, { experimental_panel: accept, experimental_panelTabs: tabs });
      expect(slot.experimental_panelCalls).toEqual([{ method: "closeTab", key: "tab-od" }]);
      cleanup();
    }
  });

  it("the composer banner reconciles, so a thread's view fixes itself without the tab being drawn", async () => {
    const slot = renderSlot<object, RpcContract>({ component: OfferBanner }, {}, {
      rpc: handlers(() => view({ offer: null })),
      experimental_rpcContract: rpcContract,
      composer: { scope: { kind: "thread", threadId: WORK } },
      sidebarThreads: { status: "ready", threads: [sidebarThread()] },
      experimental_panel: accept,
      experimental_panelTabs: onDemandOpen(false),
    });
    await waitFor(() => expect(slot.experimental_panelCalls).toEqual([{ method: "closeTab", key: "tab-od" }]));
  });

  it("a leftover on-demand tab hands itself over when drawn, in a sub-agent thread too", async () => {
    const slot = renderSlot({ component: LearningOnDemandTab }, { threadId: WORK, environment: null, params: null }, {
      rpc: handlers(() => view({ eligible: false, offer: null })) as never,
      experimental_rpcContract: rpcContract,
      sidebarThreads: { status: "ready", threads: [sidebarThread({ parentThreadId: "thr_mate" })] },
      experimental_panel: accept,
      experimental_panelTabs: onDemandOpen(true),
    });
    await waitFor(() => expect(slot.experimental_panelCalls.map((call) => call.method)).toEqual(["openTab", "closeTab"]));
  });
});

describe("file references", () => {
  const workspace = { threadId: "thr_fork", environmentId: "env_1", rootPath: "/work/calc" };
  const document = { threadId: "thr_fork", rootPath: "/work/calc", target: { kind: "workspace", environmentId: "env_1", path: "learning-exercise.md" } };
  const documentOf = (element: HTMLElement) => JSON.parse(element.getAttribute("data-document")!) as unknown;

  it.each([
    ["calc.py", "calc.py", null],
    ["calc.py:12", "calc.py", { kind: "line", line: 12, column: null }],
    ["calc.py:12:4", "calc.py", { kind: "line", line: 12, column: null }],
    ["src/stats.ts:40-60", "src/stats.ts", { kind: "range", startLine: 40, endLine: 60 }],
    ["src/stats.ts#L40", "src/stats.ts", { kind: "line", line: 40, column: null }],
    ["src/stats.ts#L40-L60", "src/stats.ts", { kind: "range", startLine: 40, endLine: 60 }],
    ["src/stats.ts:60-40", "src/stats.ts:60-40", null],
    ["src/stats.ts:0", "src/stats.ts:0", null],
  ])("reads %s as a path and a line or range", (reference, path, location) => {
    expect(parseFileRef(reference)).toEqual({ path, location });
  });

  it.each([
    ["calc.py", true],
    ["src/stats.ts:40-60", true],
    ["./Makefile", true],
    ["median([])", false],
    ["ValueError", false],
    ["git log -1", false],
    ["https://example.com/a.ts", false],
    ["/abs/path.ts", false],
    ["../outside.py", false],
  ])("treats %s as a file reference: %s", (text, expected) => {
    expect(looksLikeFileRef(text)).toBe(expected);
  });

  it.each([
    ["./src/a.ts", "src/a.ts"],
    ["src/./a.ts", "src/a.ts"],
    ["src/../calc.py", "calc.py"],
    ["src//a.ts", "src/a.ts"],
    ["../outside.py", null],
    ["src/../../outside.py", null],
    ["/abs/a.ts", null],
    ["~/a.ts", null],
    [".", null],
  ])("normalizes %s to a workspace path: %s", (path, expected) => {
    expect(workspacePath(path)).toBe(expected);
  });

  it("the harness's FileLink runs the SDK's file-target validator, which leaves a raw ./ path inert", () => {
    const slot = renderSlot({ component: () => <FileLink target={{ kind: "workspace", environmentId: "env_1", path: "./src/a.ts" }}>raw</FileLink> }, {});
    const raw = screen.getByText("raw");
    expect(raw.getAttribute("href")).toBeNull();
    fireEvent.click(raw);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("./ references open through the real FileLink at their line, keep their text as the label, and escapes stay code", () => {
    const references = ["./src/a.ts:42", "./Makefile", "src/../calc.py:3-5", "../outside.py:1"];
    const slot = renderSlot({ component: () => <>{references.map((reference) => <FileRef key={reference} reference={reference} environmentId="env_1" />)}</> }, {});
    for (const name of references.slice(0, 3)) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("href")).not.toBeNull();
      fireEvent.click(link);
    }
    expect(screen.queryByRole("link", { name: "../outside.py:1" })).toBeNull();
    expect(screen.getByText("../outside.py:1").tagName).toBe("CODE");
    expect(slot.navigateCalls).toEqual([
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "src/a.ts" }, location: { kind: "line", line: 42, column: null } } },
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "Makefile" }, location: null } },
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "calc.py" }, location: { kind: "range", startLine: 3, endLine: 5 } } },
    ]);
  });

  it("resolves Markdown against a file at the workspace root, and leaves bb's own routing without a workspace", () => {
    expect(markdownDocument(workspace)).toEqual(document);
    expect(markdownDocument(null)).toBeUndefined();
    expect(markdownDocument(undefined)).toBeUndefined();
  });

  it("the card's question resolves its file references in the session's workspace, and its files open at their lines", () => {
    const payload: CardPayload = {
      sessionId: "ses_1",
      ordinal: 1,
      type: "trace",
      question: "Open `calc.py:12` and trace `median([3, 1])`.",
      files: ["calc.py:12", "tests/test_calc.py:5-9", "README.md"],
      environmentId: "env_1",
      workspace,
      topic: '"Add median"',
      maxQuestions: 8,
    };
    const slot = renderSlot({ component: ExerciseCard }, { interaction: { id: "pint_1", threadId: "thr_fork", title: "Question 1", payload, createdAt: 1, expiresAt: null }, submit: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });
    const question = screen.getByTestId("bb-markdown");
    expect(question.textContent).toBe(payload.question);
    expect(documentOf(question)).toEqual(document);
    for (const name of payload.files) fireEvent.click(screen.getByRole("link", { name }));
    expect(slot.navigateCalls).toEqual([
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "calc.py" }, location: { kind: "line", line: 12, column: null } } },
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "tests/test_calc.py" }, location: { kind: "range", startLine: 5, endLine: 9 } } },
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "README.md" }, location: null } },
    ]);
  });

  it("a card an earlier build opened, with no workspace, keeps bb's own routing", () => {
    const payload = { sessionId: "ses_1", ordinal: 1, type: "trace", question: "Q?", files: [], environmentId: null, topic: "t", maxQuestions: 8 };
    renderSlot({ component: ExerciseCard }, { interaction: { id: "pint_1", threadId: "thr_fork", title: "Question 1", payload, createdAt: 1, expiresAt: null }, submit: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });
    expect(screen.getByTestId("bb-markdown").getAttribute("data-document")).toBe("none");
  });

  it("the settled row resolves the question in the card's workspace", () => {
    renderSlot({ component: SettledRow }, {
      row: { id: "r", threadId: "t", turnId: null, kind: "learning-exercises/exercise", toolName: null, status: "completed", startedAt: 1, completedAt: 2 },
      payload: { question: "Open `calc.py:12`.", action: "skip", answer: null, confidence: null, workspace },
      presentation: null,
      thread: { id: "t", providerId: null },
      Original: () => <span>original</span>,
    } as never);
    expect(documentOf(screen.getByTestId("bb-markdown"))).toEqual(document);
  });

  it("the tab's session history shows each question as Markdown in the session's workspace", async () => {
    const finished = { ...session, id: "ses_2", state: "finished" as const, summary: null, pauseReason: null, finishedAt: 3 };
    const exercise = { ordinal: 1, type: "trace", question: "Open `calc.py:12`.", files: [], askedAt: 1, answer: "It sorts", confidence: 3, skipped: false, stuck: 0, answeredAt: 2, verdict: "partly", gap: null, form: null, fields: null, reply: null };
    renderSlot({ component: LearningTab }, { threadId: WORK, environment: null }, {
      rpc: handlers(() => view({ offer: null }), {
        projectSessions: () => ({ paused: [], previous: [finished], hasMore: false }),
        sessionDetail: () => ({ session: finished, exercises: [exercise], workspace }),
      }),
      experimental_rpcContract: rpcContract,
      sidebarThreads: { status: "ready", threads: [sidebarThread()] },
    });
    fireEvent.click(await screen.findByRole("button", { expanded: false }));
    const question = await screen.findByTestId("bb-markdown");
    expect(question.textContent).toBe("Open `calc.py:12`.");
    expect(documentOf(question)).toEqual(document);
  });

  it("the offer links the paths in its topic in this thread's workspace, and leaves other text alone", async () => {
    const newFiles: Offer = { ...offer, trigger: "new-files", topic: "the new `stats/median.py` and `*draft*`" };
    const slot = renderSlot<object, RpcContract>({ component: OfferBanner }, {}, {
      rpc: handlers(() => view({ offer: newFiles })),
      experimental_rpcContract: rpcContract,
      composer: { scope: { kind: "thread", threadId: WORK } },
      sidebarThreads: { status: "ready", threads: [sidebarThread()] },
    });
    fireEvent.click(await screen.findByRole("link", { name: "stats/median.py" }));
    expect(slot.navigateCalls).toEqual([
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "stats/median.py" }, location: null } },
    ]);
    expect(screen.getByText("*draft*").tagName).toBe("CODE");
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

describe("the agent's reply between questions (thread thr_f6iewpgi7a)", () => {
  const workspace = { threadId: "thr_fork", environmentId: "env_1", rootPath: "/work/calc" };
  const feedback = "You got all three right. What your walkthrough leaves out is *why there's no spill*.";
  const payload: CardPayload = { sessionId: "ses_1", ordinal: 2, type: "debug", question: "When does the map jump back?", files: [], environmentId: "env_1", workspace, topic: "t", maxQuestions: 8 };
  const renderCard = (card: CardPayload) =>
    renderSlot({ component: ExerciseCard }, { interaction: { id: "pint_2", threadId: "thr_fork", title: "Question 2", payload: card, createdAt: 1, expiresAt: null }, submit: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });

  it("the card shows the feedback on the previous answer above the question, open, in the session's workspace", () => {
    renderCard({ ...payload, previous: { ordinal: 1, answered: true, reply: feedback } });
    const summary = screen.getByText("Feedback on question 1");
    const details = summary.closest("details")!;
    expect(details.open).toBe(true);
    const [reply, question] = screen.getAllByTestId("bb-markdown");
    expect(reply!.textContent).toBe(feedback);
    expect(details.contains(reply!)).toBe(true);
    expect(question!.textContent).toBe("When does the map jump back?");
    expect(reply!.compareDocumentPosition(question!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reply!.getAttribute("data-document")).toBe(question!.getAttribute("data-document"));
    // It folds away on request, and its toggle is not a button that could submit bb's composer form.
    fireEvent.click(summary);
    for (const button of screen.getAllByRole("button")) expect(button.getAttribute("type")).toBe("button");
  });

  it("after a skipped question it says so, and the first question has nothing above it", () => {
    renderCard({ ...payload, previous: { ordinal: 1, answered: false, reply: "No problem." } });
    expect(screen.getByText("After question 1")).toBeTruthy();
    cleanup();
    renderCard(payload);
    expect(screen.queryByText(/question 1/)).toBeNull();
    expect(screen.getAllByTestId("bb-markdown")).toHaveLength(1);
  });

  it("the tab keeps every reply: the open session's questions so far, and a finished session's history", async () => {
    const hosted: Session = { ...session, state: "awaiting-answer", pauseReason: null, asked: 2, answered: 1 };
    const exercises = [
      { ordinal: 1, type: "trace", question: "Trace it.", files: [], askedAt: 1, answer: "Focus ends at 2", confidence: 4, skipped: false, stuck: 0, answeredAt: 2, verdict: "correct", gap: null, form: null, fields: null, reply: feedback },
      { ordinal: 2, type: "debug", question: "When does it jump?", files: [], askedAt: 3, answer: null, confidence: null, skipped: false, stuck: 0, answeredAt: null, verdict: null, gap: null, form: null, fields: null, reply: null },
    ];
    renderSlot({ component: LearningTab }, { threadId: "thr_fork", environment: null }, {
      rpc: handlers(() => view({ offer: null, hosted, canStart: false }), { sessionDetail: () => ({ session: hosted, exercises, workspace }) }),
      experimental_rpcContract: rpcContract,
      sidebarThreads: { status: "ready", threads: [sidebarThread({ id: "thr_fork" })] },
    });
    const toggle = await screen.findByRole("button", { name: /Questions and feedback so far \(2\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const label = await screen.findByText("Feedback");
    expect(label.parentElement!.textContent).toContain(feedback);
    expect(screen.getAllByText("Feedback")).toHaveLength(1);
    expect(screen.getByText("Not answered.")).toBeTruthy();
  });
});
