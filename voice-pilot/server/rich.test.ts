import { describe, expect, it } from "vitest";

import { LinkList, flattenUi, parseUi, parts, readableReply } from "./rich";

const CARD = `Card("Open pull requests", [
  Row([
    Metric("Open", "3", "2 need you", tone: "warn"),
    Metric("CI", "green", tone: "good")
  ]),
  Table(["PR", "What", "Next"], [
    ["https://github.com/acme/web/pull/20", "Login: remember the device", "You: approve, then merge"],
    ["https://github.com/acme/api/pull/7", "Rate limits per key", "The reviewer, not you"]
  ], source: "GitHub, this morning")
])`;

describe("parseUi", () => {
  it("reads calls, arrays, named arguments, objects and escapes", () => {
    const [card] = parseUi(`Card("A \\"quoted\\" title", [Steps([{title: "Build", status: "done"}])], note: 'n')`) ?? [];
    expect(card).toMatchObject({ kind: "call", name: "Card", args: ['A "quoted" title', [{ kind: "call", name: "Steps" }]], named: { note: "n" } });
  });

  it("answers null for text it cannot read", () => {
    expect(parseUi(`Card("open`)).toBeNull();
    expect(parseUi(`Card(#)`)).toBeNull();
  });
});

describe("flattenUi", () => {
  it("gives a card's metrics and every table row, with the links numbered", () => {
    const links = new LinkList();
    const lines = flattenUi(CARD, links);
    expect(lines).toEqual([
      "Open pull requests:",
      "- Open: 3 (2 need you; warn)",
      "- CI: green (good)",
      "- Row 1: PR: [link 1]; What: Login: remember the device; Next: You: approve, then merge",
      "- Row 2: PR: [link 2]; What: Rate limits per key; Next: The reviewer, not you",
      "(source: GitHub, this morning)",
    ]);
    expect(links.links).toEqual([
      { n: 1, url: "https://github.com/acme/web/pull/20" },
      { n: 2, url: "https://github.com/acme/api/pull/7" },
    ]);
  });

  it("reads steps and timelines as one line per entry, details and links inside them included", () => {
    const links = new LinkList();
    const lines = flattenUi(`Card("Today", [Steps([{title: "Decide on the CLI", detail: "https://github.com/acme/cli/pull/3, CI green", status: "current"}]), Timeline([{time: "09:10", text: "Deployed"}])])`, links);
    expect(lines).toEqual(["Today:", "- Decide on the CLI ([link 1], CI green; status current)", "- Deployed (time 09:10)"]);
  });

  it("keeps a block it cannot read as its raw text", () => {
    const links = new LinkList();
    expect(flattenUi(`Card("Broken", [`, links)).toEqual(["(A card bb shows; its raw text:)", 'Card("Broken", [']);
  });

  it("names a component it does not know and keeps its content", () => {
    expect(flattenUi(`Gauge("Disk", "71%")`, new LinkList())).toEqual(["Gauge: Disk", "71%"]);
  });
});

describe("readableReply", () => {
  it("keeps the prose, flattens the ui block and numbers every link once", () => {
    const reply = [
      "## Status",
      "",
      "Two **pull requests** are open ([the board](https://example.com/board)); see @thread:thr_abc123#msg=4.",
      "",
      "```ui",
      CARD,
      "```",
      "",
      "```sh",
      "npm test",
      "```",
      "",
      "The first is https://github.com/acme/web/pull/20.",
    ].join("\n");
    const { text, links } = readableReply(reply);
    expect(text).toBe(
      [
        "Status",
        "",
        "Two pull requests are open (the board [link 3]); see a thread [link 4].",
        "",
        "Open pull requests:",
        "- Open: 3 (2 need you; warn)",
        "- CI: green (good)",
        "- Row 1: PR: [link 1]; What: Login: remember the device; Next: You: approve, then merge",
        "- Row 2: PR: [link 2]; What: Rate limits per key; Next: The reviewer, not you",
        "(source: GitHub, this morning)",
        "",
        "Code (sh), not to be read aloud:",
        "npm test",
        "",
        "The first is [link 1].",
      ].join("\n"),
    );
    expect(links.map((link) => link.url)).toEqual([
      "https://github.com/acme/web/pull/20",
      "https://github.com/acme/api/pull/7",
      "https://example.com/board",
      "bb:thread/thr_abc123#msg=4",
    ]);
    expect(links[2]).toMatchObject({ text: "the board" });
  });

  it("keeps a link's number across reads, and names only the links each text has", () => {
    const links = new LinkList();
    readableReply("First https://example.com/a and https://example.com/b", links);
    expect(readableReply("Again https://example.com/b/ and https://example.com/c", links)).toEqual({
      text: "Again [link 2] and [link 3]",
      links: [
        { n: 2, url: "https://example.com/b" },
        { n: 3, url: "https://example.com/c" },
      ],
    });
    expect(links.byUrl("HTTPS://EXAMPLE.COM/a/")?.n).toBe(1);
    expect(links.byNumber(3)?.url).toBe("https://example.com/c");
  });

  it("keeps an unclosed ui block's content", () => {
    expect(readableReply("```ui\nMetric(\"Tests\", \"281\")").text).toBe("- Tests: 281");
  });
});

describe("parts", () => {
  it("cuts at line ends", () => {
    expect(parts("aaaa\nbbbb\ncccc", 10)).toEqual(["aaaa\nbbbb", "cccc"]);
    expect(parts("short", 10)).toEqual(["short"]);
  });
});
