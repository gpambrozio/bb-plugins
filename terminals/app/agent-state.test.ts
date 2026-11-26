import { describe, expect, it } from "vitest";

import { MAX_TYPED_NOTES, createAgentPanelStore } from "./agent-state";

describe("the commands the agent typed into a tab", () => {
  it("keeps them in order per tab, at most the latest hundred, until cleared", () => {
    const store = createAgentPanelStore();
    for (let index = 0; index < MAX_TYPED_NOTES + 5; index += 1) store.noteTyped("term_1", `echo ${index}`, index);
    store.noteTyped("term_2", "ls", 1);
    const kept = store.get().typed.get("term_1") ?? [];
    expect(kept).toHaveLength(MAX_TYPED_NOTES);
    expect(kept[0]?.command).toBe("echo 5");
    expect(kept.at(-1)?.command).toBe(`echo ${MAX_TYPED_NOTES + 4}`);
    store.clearTyped("term_1");
    expect(store.get().typed.has("term_1")).toBe(false);
    expect(store.get().typed.get("term_2")).toEqual([{ command: "ls", at: 1 }]);
  });
});
