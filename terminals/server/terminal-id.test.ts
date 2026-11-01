import { describe, expect, it } from "vitest";

import { newTerminalId } from "./terminal-id";

describe("newTerminalId", () => {
  it("makes ids bb's terminals.create accepts", () => {
    // bb 0.48.1's terminalSessionIdSchema.
    const bbPattern = /^term_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u;
    const ids = new Set(Array.from({ length: 200 }, () => newTerminalId()));
    for (const id of ids) expect(id).toMatch(bbPattern);
    expect(ids.size).toBe(200);
  });
});
