import { describe, expect, it } from "vitest";

import { bbThreadLink } from "./links";

describe("a link to this bb's own thread", () => {
  it("names the thread when the link is on this window's address", () => {
    expect(bbThreadLink("https://bb.example.app/projects/proj_x/threads/thr_abc123", "https://bb.example.app")).toBe("thr_abc123");
    expect(bbThreadLink("https://bb.example.app/thr_abc123?panel=info", "https://bb.example.app")).toBe("thr_abc123");
  });

  it("is not one on another address, without a thread, or not a link", () => {
    expect(bbThreadLink("https://other.example/threads/thr_abc123", "https://bb.example.app")).toBeNull();
    expect(bbThreadLink("https://bb.example.app/settings", "https://bb.example.app")).toBeNull();
    expect(bbThreadLink("not a link", "https://bb.example.app")).toBeNull();
  });
});
