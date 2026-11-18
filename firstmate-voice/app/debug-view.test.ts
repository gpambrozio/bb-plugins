import { describe, expect, it } from "vitest";

import type { DebugEntry, DebugPage } from "../server/debug-log";
import { DEBUG_OPEN_WAIT_MS, DEBUG_TAB, EMPTY_DEBUG, asText, isLong, makeDebugOpenRequest, mergePage, nextSeq, openDebugLog, sinceStart, visible } from "./debug-view";

const entry = (seq: number, overrides: Partial<DebugEntry> = {}): DebugEntry => ({ seq, at: 1_000 + seq * 100, kind: "heard", title: `Entry ${seq}`, ...overrides });
const page = (sessionId: string | null, entries: DebugEntry[], more = false): DebugPage => ({ sessionId, startedAt: 1_000, entries, more, dropped: 0 });

describe("the debug view's state", () => {
  it("takes a first session's page whole, then adds only what is new", () => {
    let { state, reread } = mergePage(EMPTY_DEBUG, page("fmv_1", [entry(1), entry(2)]));
    expect(reread).toBe(false);
    expect(nextSeq(state)).toBe(2);
    ({ state } = mergePage(state, page("fmv_1", [entry(2), entry(3)])));
    expect(state.entries.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("starts over when listening starts again, reading the new session from its start", () => {
    const { state } = mergePage(EMPTY_DEBUG, page("fmv_1", [entry(1), entry(2), entry(3)]));
    const next = mergePage(state, page("fmv_2", [entry(4)]));
    expect(next.reread).toBe(true);
    expect(next.state).toMatchObject({ sessionId: "fmv_2", entries: [] });
    expect(nextSeq(next.state)).toBe(0);
    const read = mergePage(next.state, page("fmv_2", [entry(1), entry(2)]));
    expect(read.state.entries.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("hides the turn markers on request, folds long texts, and copies as plain text", () => {
    const entries = [entry(1, { kind: "turn", title: "The captain started speaking" }), entry(2, { text: "Hold it for now." })];
    expect(visible(entries, false).map((item) => item.seq)).toEqual([2]);
    expect(isLong("short")).toBe(false);
    expect(isLong("x".repeat(700))).toBe(true);
    expect(isLong("a\n".repeat(20))).toBe(true);
    expect(sinceStart(2_500, 1_000)).toBe("+1.5 s");
    const text = asText({ sessionId: "fmv_1", startedAt: 1_000, entries, dropped: 0 });
    expect(text.split("\n")[0]).toBe("FirstMate voice debug log, session fmv_1");
    expect(text).toMatch(/\] Heard: Entry 2\n {4}Hold it for now\.$/u);
  });
});

describe("opening the debug tab", () => {
  const TAB = { id: "debug", context: { kind: "thread" }, availability: "action" };

  it("opens the side-panel tab through the focused surface's panel when it takes it", () => {
    const request = makeDebugOpenRequest(() => 0);
    const calls: unknown[] = [];
    openDebugLog({ openTab: (options) => (calls.push(options), true) }, "thr_mate", request);
    expect(calls).toEqual([{ tab: TAB }]);
    expect(DEBUG_TAB).toEqual(TAB);
    expect(request.wanted).toBeNull();
  });

  it("leaves a request for the thread's own view when the surface declines, or for the first mate's thread with none", () => {
    const request = makeDebugOpenRequest(() => 0);
    openDebugLog({ openTab: () => false }, "thr_mate", request);
    expect(request.wanted).toEqual({ threadId: "thr_mate", at: 0 });
    expect(request.isFor("thr_mate")).toBe(true);
    expect(request.isFor("thr_other")).toBe(false);
    expect(request.isFor(null)).toBe(false);
    openDebugLog({ openTab: () => false }, null, request);
    expect(request.wanted).toEqual({ threadId: null, at: 0 });
    expect(request.isFor(null)).toBe(false);
  });

  it("forgets a request its thread did not take in time, and tells its listeners", () => {
    let now = 0;
    const request = makeDebugOpenRequest(() => now);
    const heard: (string | null | undefined)[] = [];
    request.subscribe(() => heard.push(request.wanted?.threadId));
    request.ask("thr_mate");
    now = DEBUG_OPEN_WAIT_MS + 1;
    expect(request.isFor("thr_mate")).toBe(false);
    request.done();
    request.done();
    expect(heard).toEqual(["thr_mate", undefined]);
  });
});
