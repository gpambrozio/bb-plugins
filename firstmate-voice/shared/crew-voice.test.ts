import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("the voice.v1 contract", () => {
  it("is firstmate-crew's, byte for byte below the copy's note", async () => {
    const crew = await readFile(new URL("../../firstmate-crew/shared/voice.ts", import.meta.url), "utf8");
    const copy = await readFile(new URL("./crew-voice.ts", import.meta.url), "utf8");
    expect(copy.split("\n").slice(3).join("\n")).toBe(crew);
  });
});
