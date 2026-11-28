import { describe, expect, it } from "vitest";

import { DEBUG_MAX_ENTRIES, DEBUG_MAX_TEXT, DebugLog, scrub } from "./debug-log";

describe("the debug log", () => {
  it("numbers and times each entry, in order", () => {
    let now = 1_000;
    const log = new DebugLog("vp_1", 1_000, () => now);
    log.add("session", "Listening started");
    now = 1_500;
    log.add("heard", "The user said", "Hold it for now.");
    expect(log.page(0).entries).toEqual([
      { seq: 1, at: 1_000, kind: "session", title: "Listening started" },
      { seq: 2, at: 1_500, kind: "heard", title: "The user said", text: "Hold it for now." },
    ]);
    expect(log.page(1).entries.map((entry) => entry.seq)).toEqual([2]);
  });

  it("drops the oldest entries past the cap, but keeps the briefing", () => {
    const log = new DebugLog("vp_1", 0, () => 0);
    log.add("briefing", "Standing instructions", "Be brief.");
    for (let i = 0; i < DEBUG_MAX_ENTRIES + 5; i += 1) log.add("turn", `Turn ${i}`);
    const all = [];
    for (let after = 0, page = log.page(0); ; page = log.page(after)) {
      all.push(...page.entries);
      after = page.entries.at(-1)?.seq ?? after;
      if (!page.more) break;
    }
    expect(all).toHaveLength(DEBUG_MAX_ENTRIES);
    expect(all[0]?.kind).toBe("briefing");
    expect(all[1]?.title).toBe("Turn 6");
    expect(log.page(0).dropped).toBe(6);
  });

  it("cuts a very long text and says by how much", () => {
    const log = new DebugLog("vp_1", 0, () => 0);
    log.add("context", "A brief", "x".repeat(DEBUG_MAX_TEXT + 10));
    expect(log.page(0).entries[0]?.text?.endsWith("… (10 more characters cut)")).toBe(true);
  });

  it("keeps nothing credential-shaped", () => {
    expect(scrub("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [redacted]");
    expect(scrub("key sk-proj-ABCDEFGHIJKLMNOP and ek_123abc")).toBe("key sk-[redacted] and ek_[redacted]");
    expect(scrub("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).toBe("token [jwt]");
    const log = new DebugLog("vp_1", 0, () => 0);
    log.add("error", "Refused with Bearer abc123", "sk-live-0123456789abcdef");
    expect(JSON.stringify(log.page(0))).not.toMatch(/abc123|0123456789abcdef/u);
  });
});
