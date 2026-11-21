import { describe, expect, it } from "vitest";

import { describe as describeProject } from "./description";

describe("describe", () => {
  it("skips the title and the boilerplate line generated AGENTS.md files open with", () => {
    const text = [
      "# AGENTS.md",
      "",
      "This file provides guidance to coding agents working in this repository.",
      "",
      "Plugins for [bb](https://getbb.app), one self-contained folder per plugin. They are ports of the",
      "six Paseo plugins.",
      "",
      "## Porting",
      "Details.",
    ].join("\n");
    expect(describeProject(text)).toBe("Plugins for bb, one self-contained folder per plugin. They are ports of the six Paseo plugins.");
  });

  it("is null for a CLAUDE.md that only imports AGENTS.md", () => {
    expect(describeProject("@AGENTS.md\n")).toBeNull();
  });

  it("skips front matter, badges and HTML in a README", () => {
    const text = [
      "---",
      "title: x",
      "---",
      "<p align=\"center\"><img src=\"logo.png\"></p>",
      "",
      "[![CI](https://x/badge.svg)](https://x)",
      "",
      "# Instax party",
      "A print server for an Instax printer at parties.",
    ].join("\n");
    expect(describeProject(text)).toBe("A print server for an Instax printer at parties.");
  });

  it("is null when nothing but headings and code is there", () => {
    expect(describeProject("# Title\n\n```sh\nnpm i\n```\n\n## Usage\n")).toBeNull();
  });
});
