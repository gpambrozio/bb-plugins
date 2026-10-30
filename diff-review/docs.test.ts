import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("the README", () => {
  it("installs a floor-only range that includes this version (a 0.x caret range stops at the next minor)", () => {
    const version = (JSON.parse(read("./package.json")) as { version: string }).version;
    const range = /bb plugin install 'git:github\.com\/gpambrozio\/bb-plugins@>=(\d+)\.(\d+)\.(\d+)'/.exec(read("./README.md"));
    expect(range).not.toBeNull();
    const floor = range!.slice(1, 4).map(Number);
    const current = version.split(".").map(Number);
    const compare = floor.map((part, i) => part - current[i]!).find((diff) => diff !== 0) ?? 0;
    expect(compare).toBeLessThanOrEqual(0);
  });
});
