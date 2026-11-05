// @vitest-environment jsdom
/**
 * Answer forms in the card (every control, by its accessible name, as a keyboard or screen-reader user
 * reaches it), the fallback to the text box, and the answer read back in the transcript and the tab.
 */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVERY_KIND, EVERY_KIND_ANSWER } from "../server/testing/forms";
import { sanitizeValues, summarizeAnswer } from "../shared/answer-form";
import { rpcContract } from "../shared/contract";
import type { CardPayload, Session, ThreadView } from "../shared/types";
import { ExerciseCard } from "./card";
import { SettledRow } from "./settled-row";
import { LearningTab } from "./tab";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(cleanup);

const workspace = { threadId: "thr_fork", environmentId: "env_1", rootPath: "/work/calc" };
const base: CardPayload = { sessionId: "ses_1", ordinal: 1, type: "prediction", question: "Read `calc.py:12`.", files: [], environmentId: "env_1", workspace, topic: '"Add median"', maxQuestions: 8 };

function renderCard(form: unknown) {
  const submit = vi.fn(async () => {});
  const payload = { ...base, form } as CardPayload;
  renderSlot({ component: ExerciseCard }, { interaction: { id: "pint_1", threadId: "thr_fork", title: "Question 1", payload, createdAt: 1, expiresAt: null }, submit, cancel: vi.fn(async () => {}) });
  return submit;
}

const group = (name: string) => screen.getByRole("group", { name: new RegExp(`^${name.replace(/[?()[\]]/g, "\\$&")}`) });
const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;

/** Answers `EVERY_KIND` through its controls, as `EVERY_KIND_ANSWER` has it. */
function fillEveryKind() {
  fireEvent.change(screen.getByLabelText("Function name"), { target: { value: "median" } });
  fireEvent.change(screen.getByLabelText("Calls"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Risk"), { target: { value: "30" } });
  fireEvent.click(within(group("What happens?")).getByLabelText("It raises"));
  fireEvent.change(screen.getByLabelText("Which module?"), { target: { value: "calc" } });
  fireEvent.click(screen.getByLabelText("The CLI"));
  fireEvent.click(screen.getByLabelText("The tests"));
  fireEvent.click(within(group("Safe to call twice?")).getByLabelText("Yes"));
  fireEvent.click(within(group("How clear is the code?")).getByRole("radio", { name: "4" }));
  fireEvent.click(within(group("Order the steps")).getByRole("button", { name: "Keep this order" }));
  fireEvent.change(screen.getByLabelText("[]"), { target: { value: "error" } });
  fireEvent.change(screen.getByLabelText("[3]"), { target: { value: "three" } });
  fireEvent.change(screen.getByLabelText("Edge cases, entry 1"), { target: { value: "empty list" } });
  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  fireEvent.change(screen.getByLabelText("Edge cases, entry 2"), { target: { value: "one item" } });
  fireEvent.change(screen.getByLabelText("sorted(), Cost"), { target: { value: "3" } });
  fireEvent.click(screen.getByLabelText("sorted(), Stable"));
  fireEvent.change(screen.getByLabelText("sorted(), Grade"), { target: { value: "good" } });
  fireEvent.change(screen.getByLabelText("heapq, Cost"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("heapq, Grade"), { target: { value: "bad" } });
}

describe("an answer form in the card", () => {
  it("draws every control with a label tied to it, and sends the answer by field id with its summary", () => {
    const submit = renderCard(EVERY_KIND);
    expect(screen.queryByLabelText("Your answer")).toBeNull();
    // Required fields hold Submit back and say what they still need.
    fireEvent.click(screen.getByRole("button", { name: "3 · Fairly sure" }));
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(/^Still to answer: Function name needs an answer;/)).toBeTruthy();
    fillEveryKind();
    expect(screen.queryByText(/^Still to answer/)).toBeNull();
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    expect(submit).toHaveBeenCalledWith({
      action: "answer",
      answer: summarizeAnswer(EVERY_KIND, sanitizeValues(EVERY_KIND, EVERY_KIND_ANSWER)),
      confidence: 3,
      fields: sanitizeValues(EVERY_KIND, EVERY_KIND_ANSWER),
    });
  });

  it("marks optional fields, shows help and notes as Markdown, and the section as a heading", () => {
    renderCard(EVERY_KIND);
    expect(screen.getByLabelText(/^Why\?\s*\(optional\)$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Your fix\s*py\s*\(optional\)$/).className).toContain("font-mono");
    expect(screen.getByText("Open `calc.py:12` first.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choices" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Choices" })).toBeTruthy();
    // The help is the input's description.
    const why = screen.getByLabelText(/^Why\?/);
    expect(document.getElementById(why.getAttribute("aria-describedby")!)?.textContent).toBe("See `calc.py:12-20`.");
  });

  it("lays half and third fields side by side under a container query, full ones on their own line", () => {
    renderCard(EVERY_KIND);
    expect(document.querySelector("[data-answer-form]")!.className).toContain("@container");
    expect(screen.getByLabelText("Function name").closest(".min-w-0")!.className).toContain("@md:col-span-3");
    expect(screen.getByLabelText(/^Why\?/).closest(".min-w-0")!.className).toContain("@md:col-span-6");
  });

  it("a slider is not set until it is moved, then shows its value with the unit and the end labels", () => {
    renderCard(EVERY_KIND);
    const slider = screen.getByLabelText("Risk") as HTMLInputElement;
    expect(slider.getAttribute("aria-valuetext")).toBe("not set");
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("Certain")).toBeTruthy();
    fireEvent.change(slider, { target: { value: "70" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("70%");
    expect(screen.getByText("70%", { selector: "output" })).toBeTruthy();
  });

  it("a multiple choice stops at its maximum, and a matching uses each item once", () => {
    renderCard(EVERY_KIND);
    fireEvent.click(screen.getByLabelText("The CLI"));
    fireEvent.click(screen.getByLabelText("The API"));
    expect((screen.getByLabelText("The tests") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("[]"), { target: { value: "error" } });
    const other = within(screen.getByLabelText("[3]")).getByRole("option", { name: "ValueError" }) as HTMLOptionElement;
    expect(other.disabled).toBe(true);
  });

  it("a ranking moves with labelled buttons, and the first and last cannot move out", () => {
    renderCard(EVERY_KIND);
    const order = () => within(group("Order the steps")).getAllByRole("listitem").map((item) => item.textContent?.replace(/^\d+\./, ""));
    expect(order()).toEqual(["Parse", "Sort", "Pick the middle"]);
    expect((screen.getByRole("button", { name: "Move Parse up" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move Parse down" }));
    expect(order()).toEqual(["Sort", "Parse", "Pick the middle"]);
    expect((screen.getByRole("button", { name: "Move Pick the middle down" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a list adds and removes entries up to its maximum", () => {
    renderCard(EVERY_KIND);
    const add = screen.getByRole("button", { name: "Add another" }) as HTMLButtonElement;
    for (let index = 0; index < 3; index += 1) fireEvent.click(add);
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove entry 4" }));
    expect(screen.queryByLabelText("Edge cases, entry 4")).toBeNull();
    expect(add.disabled).toBe(false);
  });

  it("a dropdown choice offers the options after a blank first entry", () => {
    renderCard(EVERY_KIND);
    const select = screen.getByLabelText("Which module?") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.text)).toEqual(["Choose…", "calc.py", "stats.py"]);
  });

  it("shows a field's problem once the learner leaves it", () => {
    renderCard(EVERY_KIND);
    const calls = screen.getByLabelText("Calls");
    fireEvent.change(calls, { target: { value: "12" } });
    expect(screen.queryByText("is above 10")).toBeNull();
    fireEvent.blur(calls);
    expect(screen.getByText("is above 10")).toBeTruthy();
    expect(calls.getAttribute("aria-invalid")).toBe("true");
  });

  it("a form with only optional parts still needs one of them answered", () => {
    renderCard({ items: [{ kind: "text", id: "a", label: "Anything?", required: false }] });
    fireEvent.click(screen.getByRole("button", { name: "2 · Unsure" }));
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Anything\?/), { target: { value: "yes" } });
    expect(submitButton().disabled).toBe(false);
  });

  it("keeps Skip, Make it more specific and Pause, and every button is a plain button", () => {
    const submit = renderCard(EVERY_KIND);
    for (const button of screen.getAllByRole("button")) expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(screen.getByRole("button", { name: "Make it more specific" }));
    expect(submit).toHaveBeenCalledWith({ action: "more-specific" });
  });

  it("a form this build cannot read falls back to the text box, never breaking the card", () => {
    const submit = renderCard({ items: [{ kind: "hologram", id: "x", label: "X" }] });
    const box = screen.getByLabelText("Your answer");
    fireEvent.change(box, { target: { value: "Plain words" } });
    fireEvent.click(screen.getByRole("button", { name: "4 · Sure" }));
    fireEvent.click(submitButton());
    expect(submit).toHaveBeenCalledWith({ action: "answer", answer: "Plain words", confidence: 4 });
  });

  it("labels and options are text, never HTML", () => {
    renderCard({ items: [{ kind: "choice", id: "c", label: "<b>bold</b>", options: [{ value: "a", label: "<img src=x onerror=alert(1)>" }, { value: "b", label: "B" }] }] });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});

describe("rankings and checkbox tables, alone (review pass 1 of dfb630d)", () => {
  const ranking = { kind: "ranking", id: "order", label: "Put them in order", items: [{ value: "parse", label: "Parse" }, { value: "sort", label: "Sort" }, { value: "pick", label: "Pick" }] };
  const checks = {
    kind: "table",
    id: "mutates",
    label: "Which mutate their input?",
    columns: [{ id: "yes", label: "Mutates", control: "checkbox" }],
    rows: [
      { id: "sort", label: "list.sort" },
      { id: "sorted", label: "sorted" },
    ],
  };
  const sure = () => fireEvent.click(screen.getByRole("button", { name: "4 · Sure" }));

  it("a ranking-only form submits once the learner reorders it", () => {
    const submit = renderCard({ items: [ranking] });
    sure();
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move Pick up" }));
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    expect(submit).toHaveBeenCalledWith({ action: "answer", answer: "- Put them in order:\n    1. Parse\n    2. Pick\n    3. Sort", confidence: 4, fields: { order: ["parse", "pick", "sort"] } });
  });

  it("a ranking already in the right order submits once the learner keeps it", () => {
    const submit = renderCard({ items: [ranking, { kind: "text", id: "note", label: "Anything else?", required: false }] });
    sure();
    expect(screen.getByText(/needs an order: move an item, or keep this order/)).toBeTruthy();
    const keep = screen.getByRole("button", { name: "Keep this order" });
    expect(keep.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(keep);
    expect(keep.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(submitButton());
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ fields: { order: ["parse", "sort", "pick"], note: "" } }));
  });

  it("a required checkbox-only table submits once a box is ticked, the others as unticked", () => {
    const submit = renderCard({ items: [checks] });
    sure();
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("list.sort, Mutates"));
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    expect(submit).toHaveBeenCalledWith({
      action: "answer",
      answer: "- Which mutate their input?:\n    list.sort: Mutates yes\n    sorted: Mutates no",
      confidence: 4,
      fields: { mutates: { sort: { yes: true }, sorted: { yes: false } } },
    });
  });

  it("all unticked is an answer once the learner confirms it", () => {
    const submit = renderCard({ items: [checks] });
    sure();
    expect(screen.getByText(/needs its boxes ticked, or the unticked ones confirmed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm unticked boxes" }));
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ answer: "- Which mutate their input?:\n    list.sort: Mutates no\n    sorted: Mutates no", fields: { mutates: { sort: { yes: false }, sorted: { yes: false } } } }));
  });

  it("an optional mixed table beside answered text: the ticks show in the summary as in the JSON", () => {
    const submit = renderCard({
      items: [
        { kind: "text", id: "why", label: "Why?" },
        { ...checks, required: false, columns: [...checks.columns, { id: "note", label: "Note", control: "text" }] },
      ],
    });
    sure();
    fireEvent.change(screen.getByLabelText("Why?"), { target: { value: "In place" } });
    fireEvent.click(screen.getByLabelText("list.sort, Mutates"));
    fireEvent.click(submitButton());
    const sent = (submit.mock.calls as unknown as [{ answer: string; fields: Record<string, unknown> }][])[0]![0];
    expect(sent.fields.mutates).toEqual({ sort: { yes: true, note: null }, sorted: { yes: false, note: null } });
    expect(sent.answer).toContain("list.sort: Mutates yes; Note (empty)");
    expect(sent.answer).not.toContain("(no answer)");
  });

  it("the history shows an all-unticked table as no, not as no answer", () => {
    const form = { items: [checks] } as never;
    renderSlot({ component: SettledRow }, {
      row: { id: "r", threadId: "t", turnId: null, kind: "learning-exercises/exercise", toolName: null, status: "completed", startedAt: 1, completedAt: 2 },
      payload: { question: "Q?", action: "answer", answer: "x", confidence: 3, form, fields: { mutates: { sort: { yes: false }, sorted: { yes: false } } } },
      presentation: null,
      thread: { id: "t", providerId: null },
      Original: () => <span>original</span>,
    } as never);
    const view = document.querySelector("[data-answer-view]") as HTMLElement;
    expect(within(view).queryByText("No answer.")).toBeNull();
    const body = view.querySelector("tbody") as HTMLElement;
    expect(within(body).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["no", "no"]);
  });
});

describe("a form answer read back", () => {
  const fields = sanitizeValues(EVERY_KIND, EVERY_KIND_ANSWER);

  it("the settled row shows each part under its label, the table as a table", () => {
    renderSlot({ component: SettledRow }, {
      row: { id: "r", threadId: "t", turnId: null, kind: "learning-exercises/exercise", toolName: null, status: "completed", startedAt: 1, completedAt: 2 },
      payload: { question: "Q?", action: "answer", answer: summarizeAnswer(EVERY_KIND, fields), confidence: 3, workspace, form: EVERY_KIND, fields },
      presentation: null,
      thread: { id: "t", providerId: null },
      Original: () => <span>original</span>,
    } as never);
    const view = document.querySelector("[data-answer-view]") as HTMLElement;
    expect(within(view).getByText("Function name")).toBeTruthy();
    expect(within(view).getByText("median")).toBeTruthy();
    expect(within(view).getByText("The CLI, The tests")).toBeTruthy();
    expect(within(view).getByText("Why?").nextElementSibling?.textContent).toBe("No answer.");
    expect(within(view).getByRole("rowheader", { name: "heapq" })).toBeTruthy();
    expect(within(view).getByRole("columnheader", { name: "Grade" })).toBeTruthy();
    expect(screen.getByText("Confidence 3/5 · Fairly sure")).toBeTruthy();
  });

  it("a row whose form no longer reads shows the summary text", () => {
    renderSlot({ component: SettledRow }, {
      row: { id: "r", threadId: "t", turnId: null, kind: "learning-exercises/exercise", toolName: null, status: "completed", startedAt: 1, completedAt: 2 },
      payload: { question: "Q?", action: "answer", answer: "- A: b", confidence: 3, form: { items: 1 }, fields: { a: "b" } },
      presentation: null,
      thread: { id: "t", providerId: null },
      Original: () => <span>original</span>,
    } as never);
    expect(document.querySelector("[data-answer-view]")).toBeNull();
    expect(screen.getByText("- A: b")).toBeTruthy();
  });

  it("the tab's history shows a form answer part by part", async () => {
    const session: Session = { id: "ses_2", mode: "fork", state: "finished", topic: '"Add median"', trigger: "commit", sourceThreadId: "thr_work", threadId: "thr_fork", pauseReason: null, summary: null, createdAt: 1, updatedAt: 2, finishedAt: 3, asked: 1, answered: 1 };
    const exercise = { ordinal: 1, type: "trace", question: "Q?", files: [], askedAt: 1, answer: summarizeAnswer(EVERY_KIND, fields), confidence: 3, skipped: false, stuck: 0, answeredAt: 2, verdict: "partly", gap: null, form: EVERY_KIND, fields };
    const threadView = { eligible: true, canStart: true, offer: null, hosted: null, started: null, offersOn: true, projectKey: "k", projectName: "calc", projectNever: false, offersOffGlobally: false, sessionWhere: "fork", workspace } satisfies ThreadView;
    renderSlot({ component: LearningTab }, { threadId: "thr_work", environment: null }, {
      rpc: {
        threadView: () => threadView,
        projectSessions: () => ({ paused: [], previous: [session], hasMore: false }),
        sessionDetail: () => ({ session, exercises: [exercise], workspace }),
        topicChoices: () => ({ choices: [] }),
      } as never,
      experimental_rpcContract: rpcContract,
      sidebarThreads: { status: "ready", threads: [{ id: "thr_work", projectId: "proj_1", title: "t", titleFallback: null, displayTitle: "t", parentThreadId: null, lifecycleOwnerThreadId: null, originPluginId: null, originKind: null, sourceThreadId: null, status: "idle", hasPendingInteraction: false }] } as never,
    });
    fireEvent.click(await screen.findByRole("button", { expanded: false }));
    const view = await screen.findByText("Order the steps");
    expect(view.closest("[data-answer-view]")).not.toBeNull();
    expect(view.nextElementSibling?.textContent).toBe("1. Parse\n2. Sort\n3. Pick the middle");
  });
});
