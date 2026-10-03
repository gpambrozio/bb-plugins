import { describe, expect, test } from "vitest";

import { selectReported, type ReportedCommand } from "./reported";

const outline: ReportedCommand = {
  name: "outline",
  description: "Turns ideas into designs",
  argumentHint: "[topic]",
  source: "skill",
  origin: "user",
};

describe("selectReported", () => {
  test("splits on the source the provider assigned", () => {
    const result = selectReported([outline, { ...outline, name: "usage", source: "command" }], []);
    expect(result.skills.map((entry) => entry.name)).toEqual(["outline"]);
    expect(result.commands.map((entry) => entry.name)).toEqual(["usage"]);
  });

  test("carries name, description, argument hint and origin through", () => {
    expect(selectReported([outline], []).skills).toEqual([
      { name: "outline", description: "Turns ideas into designs", argumentHint: "[topic]", origin: "user" },
    ]);
    expect(selectReported([{ ...outline, origin: "builtin" }], []).skills[0]?.origin).toBe("builtin");
  });

  // bb's list has nulls where the provider gave nothing; the browser draws strings.
  test("reads a missing description or argument hint as empty", () => {
    const bare = { ...outline, description: null, argumentHint: null };
    expect(selectReported([bare], []).skills).toEqual([
      { name: "outline", description: "", argumentHint: "", origin: "user" },
    ]);
  });

  test("drops names filesystem discovery already found from both buckets", () => {
    const commands: ReportedCommand[] = [
      outline,
      { ...outline, name: "charts" },
      { ...outline, name: "usage", source: "command" },
    ];
    const result = selectReported(commands, ["outline", "usage"]);
    expect(result.skills.map((entry) => entry.name)).toEqual(["charts"]);
    expect(result.commands).toEqual([]);
  });

  // Plugin skills are discovered as `plugin:skill` and reported under the same
  // name, so the two lists agree without any name rewriting.
  test("matches a discovered plugin skill by its namespaced name", () => {
    const commands = [{ ...outline, name: "toolkit:outline" }];
    expect(selectReported(commands, ["toolkit:outline"]).skills).toEqual([]);
  });

  test("sorts each bucket by name", () => {
    const commands: ReportedCommand[] = [
      { ...outline, name: "zebra" },
      { ...outline, name: "alpha" },
      { ...outline, name: "yak", source: "command" },
      { ...outline, name: "bison", source: "command" },
    ];
    const result = selectReported(commands, []);
    expect(result.skills.map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
    expect(result.commands.map((entry) => entry.name)).toEqual(["bison", "yak"]);
  });

  test("drops a duplicate name the provider reported twice", () => {
    const commands = [outline, { ...outline, description: "Second copy" }];
    expect(selectReported(commands, []).skills).toEqual([
      { name: "outline", description: "Turns ideas into designs", argumentHint: "[topic]", origin: "user" },
    ]);
  });

  test("tolerates an empty list", () => {
    expect(selectReported([], ["outline"])).toEqual({ skills: [], commands: [] });
  });
});
