// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { readInsets } from "./insets";

describe("readInsets", () => {
  it("reads the four paddings the probe's env() values resolve to", () => {
    const probe = document.createElement("div");
    probe.style.padding = "0px 84px 34px 0px";
    document.body.appendChild(probe);
    expect(readInsets(probe)).toEqual({ top: 0, right: 84, bottom: 34, left: 0 });
  });

  it("reads an unresolved value as zero", () => {
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    expect(readInsets(probe)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
