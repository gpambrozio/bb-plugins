import { describe, expect, it } from "vitest";

import { MAX_PIPELINED_WRITES, MAX_WRITES_AHEAD } from "./limits";

describe("the write window", () => {
  it("stays inside what the host holds while it waits for a write", () => {
    expect(MAX_PIPELINED_WRITES).toBeLessThan(MAX_WRITES_AHEAD);
  });
});
