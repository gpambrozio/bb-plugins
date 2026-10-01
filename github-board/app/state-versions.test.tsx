// @vitest-environment jsdom
/**
 * Every response path of the templates and display-prefs hooks — fetch
 * success, fetch failure, save, local change, pushed signal — in each order
 * they can land, through the SDK's app harness.
 */
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import type { PromptSettings } from "../shared/board";
import { DISPLAY_PREFS_CHANGED, PROMPTS_CHANGED, type DisplayPrefs } from "../shared/schemas";
import { DEFAULT_PROMPTS } from "../shared/settings";
import { PromptSettingsEditor } from "./prompt-settings";
import { useDisplayPrefs, usePrompts } from "./state";

afterEach(() => cleanup());

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const templates = (issues: string): PromptSettings => ({ byType: { ...DEFAULT_PROMPTS, issues }, byProject: {} });
const prefs = (hidden: string[]): DisplayPrefs => ({ hiddenRepositories: hidden, detailWidthFraction: null });

let promptsApi: ReturnType<typeof usePrompts> | null = null;
function PromptsProbe() {
  promptsApi = usePrompts();
  return (
    <pre data-testid="prompts">
      {JSON.stringify({ issues: promptsApi.prompts?.byType.issues ?? null, error: promptsApi.error })}
    </pre>
  );
}

let prefsApi: ReturnType<typeof useDisplayPrefs> | null = null;
function PrefsProbe() {
  prefsApi = useDisplayPrefs();
  return <pre data-testid="prefs">{JSON.stringify(prefsApi.prefs?.hiddenRepositories ?? null)}</pre>;
}

function renderPrompts(rpc: Record<string, (input: unknown) => unknown>) {
  const view = renderSlot({ component: PromptsProbe }, {}, { rpc });
  const state = () => JSON.parse(view.getByTestId("prompts").textContent ?? "{}") as { issues: string | null; error: string | null };
  return { view, state };
}

function renderPrefs(rpc: Record<string, (input: unknown) => unknown>) {
  const view = renderSlot({ component: PrefsProbe }, {}, { rpc });
  const state = () => JSON.parse(view.getByTestId("prefs").textContent ?? "null") as string[] | null;
  return { view, state };
}

describe("templates: a fetch and a push", () => {
  it("push lands, then the earlier fetch fails: the push stands and no error shows", async () => {
    const fetch = deferred<PromptSettings>();
    const { view, state } = renderPrompts({ getPrompts: () => fetch.promise });
    await view.behavior.emitRealtime(PROMPTS_CHANGED, templates("Pushed"));
    fetch.reject(new Error("network down"));
    await settle();
    expect(state()).toEqual({ issues: "Pushed", error: null });
  });

  it("fetch fails, then a push lands: the push clears the error", async () => {
    const { view, state } = renderPrompts({
      getPrompts: () => Promise.reject(new Error("network down")),
    });
    await waitFor(() => expect(state().error).toBe("network down"));
    await view.behavior.emitRealtime(PROMPTS_CHANGED, templates("Pushed"));
    expect(state()).toEqual({ issues: "Pushed", error: null });
  });

  it("push lands, then the earlier fetch succeeds: the push stands", async () => {
    const fetch = deferred<PromptSettings>();
    const { view, state } = renderPrompts({ getPrompts: () => fetch.promise });
    await view.behavior.emitRealtime(PROMPTS_CHANGED, templates("Pushed"));
    fetch.resolve(templates("Fetched"));
    await settle();
    expect(state()).toEqual({ issues: "Pushed", error: null });
  });

  it("fetch succeeds, then a push lands: the push wins", async () => {
    const { view, state } = renderPrompts({ getPrompts: () => templates("Fetched") });
    await waitFor(() => expect(state().issues).toBe("Fetched"));
    await view.behavior.emitRealtime(PROMPTS_CHANGED, templates("Pushed"));
    expect(state().issues).toBe("Pushed");
  });
});

describe("templates: a save", () => {
  it("save A, another window's B is pushed, then A's answer lands: B stands, and save answers B", async () => {
    const saved = deferred<PromptSettings>();
    const { view, state } = renderPrompts({
      getPrompts: () => templates("Initial"),
      savePrompts: () => saved.promise,
    });
    await waitFor(() => expect(state().issues).toBe("Initial"));
    let answered: Promise<PromptSettings> | null = null;
    act(() => {
      answered = promptsApi!.save(templates("A"));
    });
    await view.behavior.emitRealtime(PROMPTS_CHANGED, templates("B"));
    saved.resolve(templates("A"));
    await act(async () => {
      expect((await answered!).byType.issues).toBe("B");
    });
    expect(state().issues).toBe("B");
  });

  it("save A lands, then B is pushed: B wins", async () => {
    const { view, state } = renderPrompts({
      getPrompts: () => templates("Initial"),
      savePrompts: (input) => input,
    });
    await waitFor(() => expect(state().issues).toBe("Initial"));
    await act(async () => {
      expect((await promptsApi!.save(templates("A"))).byType.issues).toBe("A");
    });
    await view.behavior.emitRealtime(PROMPTS_CHANGED, templates("B"));
    expect(state().issues).toBe("B");
  });

  it("a fetch older than the save lands after it: the save stands", async () => {
    const fetch = deferred<PromptSettings>();
    const { state } = renderPrompts({
      getPrompts: () => fetch.promise,
      savePrompts: (input) => input,
    });
    await act(async () => {
      await promptsApi!.save(templates("Saved"));
    });
    fetch.resolve(templates("Fetched before"));
    await settle();
    expect(state()).toEqual({ issues: "Saved", error: null });
  });

  it("a failed save throws and changes nothing", async () => {
    const { state } = renderPrompts({
      getPrompts: () => templates("Initial"),
      savePrompts: () => Promise.reject(new Error("disk full")),
    });
    await waitFor(() => expect(state().issues).toBe("Initial"));
    await act(async () => {
      await expect(promptsApi!.save(templates("A"))).rejects.toThrow(/disk full/);
    });
    expect(state()).toEqual({ issues: "Initial", error: null });
  });
});

describe("the template editor", () => {
  it("shows another window's newer templates, not its own delayed save", async () => {
    const saved = deferred<PromptSettings>();
    const view = renderSlot(
      { component: PromptSettingsEditor },
      {},
      {
        rpc: { getPrompts: () => templates("Initial"), savePrompts: () => saved.promise },
        sdk: { projects: { list: async () => [] } },
      },
    );
    const issuesField = () => view.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    await waitFor(() => expect(issuesField().value).toBe("Initial"));
    fireEvent.change(issuesField(), { target: { value: "A" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await view.behavior.emitRealtime(PROMPTS_CHANGED, templates("B"));
    saved.resolve(templates("A"));
    await settle();
    expect(issuesField().value).toBe("B");
  });
});

describe("display prefs", () => {
  it("a local change, then the earlier fetch lands: the change stands", async () => {
    const fetch = deferred<DisplayPrefs>();
    const { state } = renderPrefs({ getDisplayPrefs: () => fetch.promise, setDisplayPrefs: () => prefs(["mine"]) });
    act(() => prefsApi!.update({ hiddenRepositories: ["mine"] }));
    fetch.resolve(prefs([]));
    await settle();
    expect(state()).toEqual(["mine"]);
  });

  it("a push, then the earlier fetch fails: the push stands rather than the defaults", async () => {
    const fetch = deferred<DisplayPrefs>();
    const { view, state } = renderPrefs({ getDisplayPrefs: () => fetch.promise });
    await view.behavior.emitRealtime(DISPLAY_PREFS_CHANGED, prefs(["pushed"]));
    fetch.reject(new Error("network down"));
    await settle();
    expect(state()).toEqual(["pushed"]);
  });

  it("a fetch that fails with nothing else known shows the defaults", async () => {
    const { state } = renderPrefs({ getDisplayPrefs: () => Promise.reject(new Error("network down")) });
    await waitFor(() => expect(state()).toEqual([]));
  });

  it("a fetch, then a push: the push wins", async () => {
    const { view, state } = renderPrefs({ getDisplayPrefs: () => prefs(["fetched"]) });
    await waitFor(() => expect(state()).toEqual(["fetched"]));
    await view.behavior.emitRealtime(DISPLAY_PREFS_CHANGED, prefs(["pushed"]));
    expect(state()).toEqual(["pushed"]);
  });
});

describe("the template editor while a save is in flight", () => {
  it("keeps what was typed during the save, still unsaved", async () => {
    const saved = deferred<PromptSettings>();
    const view = renderSlot(
      { component: PromptSettingsEditor },
      {},
      {
        rpc: { getPrompts: () => templates("Initial"), savePrompts: () => saved.promise },
        sdk: { projects: { list: async () => [] } },
      },
    );
    const issuesField = () => view.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    const saveButton = () => view.getByRole("button", { name: /^Sav/ }) as HTMLButtonElement;
    await waitFor(() => expect(issuesField().value).toBe("Initial"));
    fireEvent.change(issuesField(), { target: { value: "A" } });
    fireEvent.click(saveButton());
    fireEvent.change(issuesField(), { target: { value: "B" } });
    saved.resolve(templates("A"));
    await settle();
    expect(issuesField().value).toBe("B");
    // A is stored; B differs from it, so Save is offered again.
    expect(saveButton().disabled).toBe(false);
  });

  it("takes the stored result when nothing was typed during the save", async () => {
    const saved = deferred<PromptSettings>();
    const view = renderSlot(
      { component: PromptSettingsEditor },
      {},
      {
        rpc: { getPrompts: () => templates("Initial"), savePrompts: () => saved.promise },
        sdk: { projects: { list: async () => [] } },
      },
    );
    const issuesField = () => view.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    await waitFor(() => expect(issuesField().value).toBe("Initial"));
    fireEvent.change(issuesField(), { target: { value: "  A  " } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    // The server normalises; the editor shows what it stored.
    saved.resolve(templates("A"));
    await settle();
    expect(issuesField().value).toBe("A");
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
