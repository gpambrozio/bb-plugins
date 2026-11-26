import { describe, expect, it } from "vitest";

import { createAgentPanelStore } from "./agent-state";

describe("the agent typing into a tab", () => {
  it("counts per tab, so the tab reads its list from the server again", () => {
    const store = createAgentPanelStore();
    store.noteTyped("term_1");
    store.noteTyped("term_1");
    store.noteTyped("term_2");
    expect(store.get().typed.get("term_1")).toBe(2);
    expect(store.get().typed.get("term_2")).toBe(1);
  });
});
