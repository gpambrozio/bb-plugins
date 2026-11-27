import { describe, expect, it, vi } from "vitest";

import { promptHandlers } from "./rpc";
import { PromptEdits, STAGED_KEY } from "./prompt-edits";

const NOW = "You are Voice Pilot.\n\nStyle: speak briefly.";

/** The plugin's storage and the Instructions setting, in memory. */
function setUp(instructions = NOW) {
  const rows = new Map<string, unknown>();
  const setting = { value: instructions, writes: [] as string[] };
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
        setting.value = text;
        setting.writes.push(text);
      },
    },
    clock: { now: () => clock },
    log: { info: vi.fn(), warn: vi.fn() },
    changed,
    newId: () => `edit_${++ids}`,
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
