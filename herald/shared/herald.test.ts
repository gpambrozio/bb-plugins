import { describe, expect, it } from "vitest";

import { AttentionEntrySchema, MAX_SPEECH_CHARS, speechText, type AttentionEntry } from "./herald";

function entry(summary: AttentionEntry["summary"]): AttentionEntry {
  return {
    threadId: "t1",
    projectId: "p1",
    projectName: null,
    threadTitle: null,
    lastRequest: null,
    folder: null,
    reason: "permission",
    eventId: "e1",
    requestId: "i1",
    createdAt: "2026-09-15T10:00:00.000Z",
    headline: "Run it",
    detail: null,
    summary,
  };
}

describe("speechText", () => {
  it("never hands the voice more than the server will render, whatever was stored", () => {
    expect(speechText(entry({ status: "ready", text: "y".repeat(5000) }))?.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
  });

  it("has nothing to say while a sentence is still being written", () => {
    const pending = AttentionEntrySchema.parse(entry({ status: "pending", fallback: "Login fix finished." }));
    expect(pending.summary).toEqual({ status: "pending", fallback: "Login fix finished." });
    expect(speechText(pending)).toBeNull();
  });
});
