import { describe, expect, it } from "vitest";

import { MAX_SPEECH_CHARS, speechText, type AttentionEntry } from "./herald";

describe("speechText", () => {
  it("never hands the voice more than the server will render, whatever was stored", () => {
    const entry: AttentionEntry = {
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
      summary: { status: "ready", text: "y".repeat(5000) },
    };
    expect(speechText(entry)?.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
  });
});
