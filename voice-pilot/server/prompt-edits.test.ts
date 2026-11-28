import { describe, expect, it, vi } from "vitest";

import { promptHandlers } from "./rpc";
import { APPLY_CLAIM_MS, PromptEdits, STAGED_KEY } from "./prompt-edits";

const NOW = "You are Voice Pilot.\n\nStyle: speak briefly.";

/** The plugin's storage and the Instructions setting, in memory. */
function setUp(instructions = NOW, shared?: { rows: Map<string, unknown>; setting: { value: string; writes: string[]; hold: Promise<void> | null } }, idPrefix = "edit") {
  const rows = shared?.rows ?? new Map<string, unknown>();
  /** `hold`, while set, keeps a write of the setting from landing until it settles. */
  const setting = shared?.setting ?? { value: instructions, writes: [] as string[], hold: null as Promise<void> | null };
  let clock = 1_000;
  let ids = 0;
  const changed = vi.fn();
  const edits = new PromptEdits({
    kv: {
      get: async <T>(key: string) => (rows.has(key) ? (structuredClone(rows.get(key)) as T) : undefined),
      set: async (key, value) => void rows.set(key, structuredClone(value)),
      delete: async (key) => void rows.delete(key),
    },
    instructions: {
      get: async () => setting.value,
      set: async (text) => {
        if (setting.hold !== null) await setting.hold;
        setting.value = text;
        setting.writes.push(text);
      },
    },
    clock: { now: () => clock },
    log: { info: vi.fn(), warn: vi.fn() },
    changed,
    newId: () => `${idPrefix}_${++ids}`,
  });
  return { edits, rows, setting, changed, tick: (ms: number) => (clock += ms) };
}

describe("staging an edit of the voice's instructions", () => {
  it("stores it for review and never touches the setting", async () => {
    const { edits, rows, setting, changed } = setUp();
    const { staged, replaced } = await edits.stage({ summary: "Call the user Sam", changes: [{ find: "speak briefly.", replace: "speak briefly, and call the user Sam." }] });
    expect(replaced).toBeNull();
    expect(staged).toMatchObject({ id: "edit_1", base: NOW, proposed: "You are Voice Pilot.\n\nStyle: speak briefly, and call the user Sam.", summary: "Call the user Sam", stagedAt: 1_000, replaced: null });
    expect(rows.get(STAGED_KEY)).toEqual(staged);
    expect(setting.writes).toEqual([]);
    expect(changed).toHaveBeenCalledOnce();
    await expect(edits.read()).resolves.toEqual({ staged, current: NOW });
  });

  it("keeps one at a time: a new one replaces the one waiting, and says which", async () => {
    const { edits, tick } = setUp();
    await edits.stage({ summary: "Call the user Sam", text: `${NOW}\n\nCall the user Sam.` });
    tick(60_000);
    const { staged, replaced } = await edits.stage({ summary: "Shorter greeting", text: `${NOW}\n\nKeep the greeting short.` });
    expect(replaced).toEqual({ summary: "Call the user Sam", stagedAt: 1_000 });
    expect(staged).toMatchObject({ id: "edit_2", replaced: { summary: "Call the user Sam", stagedAt: 1_000 } });
    expect((await edits.read()).staged?.id).toBe("edit_2");
  });

  it("refuses an edit with no summary, one that changes nothing, an empty one, and a bad quote", async () => {
    const { edits, rows } = setUp();
    await expect(edits.stage({ summary: " ", text: "x" })).rejects.toThrow(/summary/u);
    await expect(edits.stage({ summary: "Same", text: NOW })).rejects.toThrow(/changes nothing/u);
    await expect(edits.stage({ summary: "Empty", text: "  " })).rejects.toThrow(/cannot be empty/u);
    await expect(edits.stage({ summary: "Missing", changes: [{ find: "not there", replace: "x" }] })).rejects.toThrow(/not in the instructions/u);
    expect(rows.size).toBe(0);
  });

  it("drops a stored edit it cannot read", async () => {
    const { edits, rows } = setUp();
    rows.set(STAGED_KEY, { id: 3 });
    await expect(edits.staged()).resolves.toBeNull();
    expect(rows.has(STAGED_KEY)).toBe(false);
  });
});

describe("the owner's review", () => {
  it("applies the edit as staged: the setting takes it, and nothing waits any more", async () => {
    const { edits, rows, setting, changed } = setUp();
    const { staged } = await edits.stage({ summary: "Sam", text: `${NOW}\n\nCall the user Sam.` });
    await edits.apply(staged.id);
    expect(setting.writes).toEqual([`${NOW}\n\nCall the user Sam.`]);
    expect(rows.has(STAGED_KEY)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    await expect(edits.read()).resolves.toEqual({ staged: null, current: `${NOW}\n\nCall the user Sam.` });
  });

  it("applies the owner's tweak of it instead, when there is one", async () => {
    const { edits, setting } = setUp();
    const { staged } = await edits.stage({ summary: "Sam", text: `${NOW}\n\nCall the user Sam.` });
    await edits.apply(staged.id, `${NOW}\n\nCall the user Samantha.`);
    expect(setting.writes).toEqual([`${NOW}\n\nCall the user Samantha.`]);
    await expect(edits.apply(staged.id)).rejects.toThrow(/No instructions edit is waiting/u);
  });

  it("refuses an empty tweak, keeping the edit waiting", async () => {
    const { edits, setting } = setUp();
    const { staged } = await edits.stage({ summary: "Sam", text: `${NOW}\n\nCall the user Sam.` });
    await expect(edits.apply(staged.id, "   ")).rejects.toThrow(/cannot be empty/u);
    expect(setting.writes).toEqual([]);
    expect((await edits.staged())?.id).toBe(staged.id);
  });

  it("rejects it: the setting stays as it was", async () => {
    const { edits, rows, setting } = setUp();
    const { staged } = await edits.stage({ summary: "Sam", text: `${NOW}\n\nCall the user Sam.` });
    await edits.reject(staged.id);
    expect(rows.has(STAGED_KEY)).toBe(false);
    expect(setting.writes).toEqual([]);
    expect(setting.value).toBe(NOW);
  });

  it("never applies or drops an edit that a newer one replaced since the owner looked", async () => {
    const { edits, setting } = setUp();
    const first = await edits.stage({ summary: "Sam", text: `${NOW}\n\nCall the user Sam.` });
    const second = await edits.stage({ summary: "Short", text: `${NOW}\n\nBe short.` });
    await expect(edits.apply(first.staged.id)).rejects.toThrow(/A newer instructions edit replaced this one/u);
    await expect(edits.reject(first.staged.id)).rejects.toThrow(/A newer instructions edit replaced this one/u);
    expect(setting.writes).toEqual([]);
    expect((await edits.staged())?.id).toBe(second.staged.id);
  });
});

describe("overlapping changes", () => {
  /** A promise and the function that settles it. */
  function gate() {
    let open = () => {};
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }
  const first = { summary: "Call the user Sam", text: `${NOW}\n\nCall the user Sam.` };
  const second = { summary: "Shorter greeting", changes: [{ find: "", replace: "Keep the greeting short." }] };

  it("keep a replacement the voice stages while the owner's Apply writes the setting", async () => {
    const { edits, setting } = setUp();
    await edits.stage(first);
    const writing = gate();
    setting.hold = writing.promise;
    const applying = edits.apply("edit_1");
    const staging = edits.stage(second);
    writing.open();
    await applying;
    const { staged } = await staging;
    // The replacement is made against the instructions the Apply wrote, and waits for review.
    expect(staged).toMatchObject({ id: "edit_2", base: first.text, proposed: `${first.text}\n\nKeep the greeting short.`, replaced: null });
    await expect(edits.read()).resolves.toEqual({ staged, current: first.text });
  });

  it("apply or reject an edit once: of two at once, the second is refused", async () => {
    const { edits, setting } = setUp();
    await edits.stage(first);
    const writing = gate();
    setting.hold = writing.promise;
    const applying = edits.apply("edit_1");
    const rejecting = edits.reject("edit_1");
    writing.open();
    await applying;
    await expect(rejecting).rejects.toThrow(/applied or rejected already/u);
    expect(setting.writes).toEqual([first.text]);
  });

  it("keep an edit the other copy of the plugin stages during a reload", async () => {
    const old = setUp();
    const fresh = setUp(NOW, { rows: old.rows, setting: old.setting }, "new");
    await old.edits.stage(first);
    const writing = gate();
    old.setting.hold = writing.promise;
    const applying = old.edits.apply("edit_1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fresh.edits.stage(second);
    writing.open();
    await applying;
    expect((await fresh.edits.read()).staged).toMatchObject({ id: "new_1", summary: "Shorter greeting" });
  });

  /** The old copy's Apply of edit_1, its setting write held, and the copy loaded by a reload beside it. */
  async function applyingAcrossReload() {
    const old = setUp();
    const fresh = setUp(NOW, { rows: old.rows, setting: old.setting }, "new");
    await old.edits.stage(first);
    const writing = gate();
    old.setting.hold = writing.promise;
    const applying = old.edits.apply("edit_1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { old, fresh, writing, applying };
  }

  it("refuse a Reject in the new copy while the old copy's Apply is still writing the setting", async () => {
    const { old, fresh, writing, applying } = await applyingAcrossReload();
    await expect(fresh.edits.reject("edit_1")).rejects.toThrow(/being applied/u);
    writing.open();
    await applying;
    // The Apply is what happened, and nothing reported a Reject that it then undid.
    await expect(fresh.edits.read()).resolves.toEqual({ staged: null, current: first.text });
    expect(old.setting.writes).toEqual([first.text]);
  });

  it("refuse a tweak in the new copy while the old copy's Apply is still writing, so neither overwrites the other", async () => {
    const { old, fresh, writing, applying } = await applyingAcrossReload();
    await expect(fresh.edits.apply("edit_1", `${NOW}\n\nCall the user Skipper.`)).rejects.toThrow(/being applied/u);
    writing.open();
    await applying;
    expect(old.setting.writes).toEqual([first.text]);
    await expect(fresh.edits.read()).resolves.toEqual({ staged: null, current: first.text });
  });

  it("put an edit back up for review when the copy applying it went away before the setting was written", async () => {
    const { old, fresh } = await applyingAcrossReload();
    // The old copy's write never lands (it was disposed mid-write); its claim lapses.
    await expect(fresh.edits.reject("edit_1")).rejects.toThrow(/being applied/u);
    fresh.tick(APPLY_CLAIM_MS);
    const { staged } = await fresh.edits.read();
    expect(staged).toMatchObject({ id: "edit_1" });
    expect(staged?.applying).toBeUndefined();
    await fresh.edits.reject("edit_1");
    await expect(fresh.edits.read()).resolves.toEqual({ staged: null, current: NOW });
    expect(old.setting.writes).toEqual([]);
  });

  it("finish an edit whose Apply landed when the copy applying it went away before tidying up", async () => {
    const old = setUp();
    const fresh = setUp(NOW, { rows: old.rows, setting: old.setting }, "new");
    await old.edits.stage(first);
    // As an Apply leaves it once the setting is written and before it drops the edit.
    old.rows.set(STAGED_KEY, { ...(old.rows.get(STAGED_KEY) as object), applying: { text: first.text, at: 1_000 } });
    old.setting.value = first.text;
    fresh.tick(APPLY_CLAIM_MS);
    await expect(fresh.edits.read()).resolves.toEqual({ staged: null, current: first.text });
    expect(fresh.changed).toHaveBeenCalled();
  });

  it("put the edit back up for review when the setting write fails", async () => {
    const { edits, setting } = setUp();
    await edits.stage(first);
    setting.hold = Promise.reject(new Error("settings are read-only"));
    await expect(edits.apply("edit_1")).rejects.toThrow(/read-only/u);
    setting.hold = null;
    const { staged } = await edits.read();
    expect(staged).toMatchObject({ id: "edit_1" });
    expect(staged?.applying).toBeUndefined();
    await edits.apply("edit_1");
    expect(setting.writes).toEqual([first.text]);
  });
});

describe("the staged edit's RPCs", () => {
  const client = { experimental_caller: { kind: "client" } } as never;
  const plugin = { experimental_caller: { kind: "plugin", pluginId: "other" } } as never;

  it("read, apply and reject for bb's app, and refuse another plugin before anything runs", async () => {
    const { edits, setting } = setUp();
    const handlers = promptHandlers(edits);
    const { staged } = await edits.stage({ summary: "Sam", text: `${NOW}\n\nCall the user Sam.` });
    await expect(handlers["prompt.staged"]({}, plugin)).rejects.toThrow(/never by another plugin/u);
    await expect(handlers["prompt.apply"]({ id: staged.id }, plugin)).rejects.toThrow(/never by another plugin/u);
    await expect(handlers["prompt.reject"]({ id: staged.id }, plugin)).rejects.toThrow(/never by another plugin/u);
    expect(setting.writes).toEqual([]);
    await expect(handlers["prompt.staged"]({}, client)).resolves.toMatchObject({ staged: { id: staged.id }, current: NOW });
    await expect(handlers["prompt.apply"]({ id: staged.id, text: "Tweaked." }, client)).resolves.toEqual({ applied: true });
    expect(setting.value).toBe("Tweaked.");
  });
});
