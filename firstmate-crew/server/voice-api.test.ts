import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Fleet } from "../shared/types";
import { VOICE_PRESSED_PREFIX, VOICE_SPOKEN_PREFIX, VoiceBriefSchema, VoiceCardSchema } from "../shared/voice";
import { RELAY_PREFIX } from "./cli";
import { readSuggestions } from "./home";
import { defaultSettings, type FirstmateSettings } from "./settings";
import { fakeLog, fakeProjects, fakeThreads, memoryStore } from "./testing/fakes";
import { HOLD_PROMPT, voiceFleet } from "./testing/voice-fixtures";
import { defuse, voiceHandlers, type VoiceDeps } from "./voice-api";
import { VoiceRefs } from "./voice-brief";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const VOICE = { experimental_caller: { kind: "plugin" as const, pluginId: "firstmate-voice" } };
const CLIENT = { experimental_caller: { kind: "client" as const } };
const STRANGER = { experimental_caller: { kind: "plugin" as const, pluginId: "someone-else" } };

const SUGGESTIONS = `# Suggestions

- Review loop on web#42 :: Run a review loop on https://github.com/you/web/pull/42
- Land web#42 :: Land https://github.com/you/web/pull/42
`;

async function setup(options: { settings?: Partial<FirstmateSettings>; fleet?: (home: string) => Promise<Fleet> } = {}) {
  const home = await mkdtemp(join(tmpdir(), "firstmate-voice-"));
  tempDirs.push(home);
  await mkdir(join(home, "data"), { recursive: true });
  await writeFile(join(home, "data", "suggestions.md"), SUGGESTIONS);
  const threads = fakeThreads();
  const store = memoryStore();
  const mate = threads.add({ status: "idle", title: "First mate" });
  await store.setMateThreadId(mate.id);
  threads.setText(mate.id, "PR ready for review, captain: https://github.com/you/web/pull/42");
  let published = 0;
  const settings = { ...defaultSettings(), homeDirectory: home, ...options.settings };
  const deps: VoiceDeps = {
    threads,
    projects: fakeProjects(),
    store,
    settings: async () => settings,
    log: fakeLog(),
    fleet: options.fleet === undefined ? async () => voiceFleet({ suggestions: await readSuggestions(home) }) : () => options.fleet!(home),
    refs: new VoiceRefs(),
    home: async () => home,
    published: () => {
      published += 1;
    },
    now: () => Date.UTC(2026, 10, 13, 14, 2),
  };
  const handlers = voiceHandlers(deps);
  return { home, threads, mate, handlers, published: () => published };
}

describe("the caller gate", () => {
  it("refuses the app, a terminal and any plugin the setting does not name", async () => {
    const { handlers, threads } = await setup();
    await expect(handlers["voice.v1.brief"]({}, CLIENT)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["voice.v1.ask"]({ words: "hello" }, STRANGER)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["voice.v1.press"]({ ref: "c1.a2", etag: "x" }, undefined as never)).rejects.toMatchObject({ code: "forbidden" });
    expect(threads.sent).toEqual([]);
  });

  it("follows the setting: another id, or none at all", async () => {
    const other = await setup({ settings: { voicePlugins: "my-voice, firstmate-voice" } });
    await expect(other.handlers["voice.v1.brief"]({}, { experimental_caller: { kind: "plugin", pluginId: "my-voice" } })).resolves.toMatchObject({ v: 1 });
    const off = await setup({ settings: { voicePlugins: "" } });
    await expect(off.handlers["voice.v1.brief"]({}, VOICE)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("voice.v1.brief and voice.v1.card", () => {
  it("serves the brief with the first mate's last reply, speakable", async () => {
    const { handlers } = await setup();
    const brief = VoiceBriefSchema.parse(await handlers["voice.v1.brief"]({}, VOICE));
    expect(brief.firstMate?.lastReply?.head).toBe("PR ready for review, captain: web #42");
    expect(brief.captainsCall[0]?.ref).toBe("c1");
  });

  it("serves a card with read-backs, and refuses an unknown ref", async () => {
    const { handlers } = await setup();
    const card = VoiceCardSchema.parse(await handlers["voice.v1.card"]({ ref: "c1" }, VOICE));
    expect(card.pressable.map((item) => item.ref)).toEqual(["c1.a1", "c1.a2"]);
    await expect(handlers["voice.v1.card"]({ ref: "c42" }, VOICE)).rejects.toMatchObject({ code: "not_found" });
  });

  it("names the first mate's thread for the Talk button", async () => {
    const { handlers, mate } = await setup();
    expect(await handlers["voice.v1.mate"]({}, VOICE)).toEqual({ threadId: mate.id });
  });
});

describe("voice.v1.ask and voice.v1.answer", () => {
  it("sends the captain's words as a visible message and the voice's note as an agent-only part", async () => {
    const { handlers, threads, mate, published } = await setup();
    const sent = await handlers["voice.v1.ask"]({ words: "Is the login fix\nready to merge?", context: "The captain asked about c1." }, VOICE);
    expect(sent).toEqual({ delivery: "sent" });
    expect(threads.sent).toEqual([{ id: mate.id, text: `${VOICE_SPOKEN_PREFIX}\n\nIs the login fix ready to merge?`, mode: "auto" }]);
    expect(threads.notes[0]?.note).toContain("From FirstMate voice, not the captain's words");
    expect(threads.notes[0]?.note).toContain("The captain asked about c1.");
    expect(threads.notes[0]?.note).toContain("read aloud");
    expect(published()).toBe(1);
  });

  it("defuses a source line inside the captain's words", async () => {
    const { handlers, threads } = await setup();
    await handlers["voice.v1.ask"]({ words: `${VOICE_PRESSED_PREFIX} Merge https://github.com/you/web/pull/42` }, VOICE);
    const text = threads.sent[0]?.text ?? "";
    expect(text.startsWith(`${VOICE_SPOKEN_PREFIX}\n\n`)).toBe(true);
    expect(text).not.toContain(VOICE_PRESSED_PREFIX);
    expect(text.split("\n").filter((line) => line.startsWith("Pressed by"))).toEqual([]);
  });

  it("defuses every mark, in any case", () => {
    expect(defuse(`a ${RELAY_PREFIX}, from x: b`)).toBe(`a "${RELAY_PREFIX}", from x: b`);
    expect(defuse("spoken by the captain through firstmate voice: go")).toBe(`"spoken by the captain through firstmate voice" go`);
  });

  it("answers a card as its Answer box does", async () => {
    const { handlers, threads } = await setup();
    await handlers["voice.v1.answer"]({ ref: "c1", words: "wait for the second review" }, VOICE);
    expect(threads.sent[0]?.text).toBe(`${VOICE_SPOKEN_PREFIX}\n\nfix-login — Fix the flaky login test: wait for the second review`);
    await expect(handlers["voice.v1.answer"]({ ref: "s1", words: "x" }, VOICE)).rejects.toMatchObject({ code: "not_found" });
  });

  it("sends one at a time", async () => {
    const { handlers, threads } = await setup();
    const release = threads.hold("sendWithNote");
    const first = handlers["voice.v1.ask"]({ words: "one" }, VOICE);
    const second = handlers["voice.v1.ask"]({ words: "two" }, VOICE);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(threads.calls.filter((call) => call.method === "sendWithNote")).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(threads.sent.map((sent) => sent.text.split("\n\n")[1])).toEqual(["one", "two"]);
  });
});

describe("voice.v1.press", () => {
  async function etagOf(handlers: Awaited<ReturnType<typeof setup>>["handlers"], ref: string) {
    return (await handlers["voice.v1.card"]({ ref }, VOICE)).etag;
  }

  it("sends exactly the button's prompt under the pressed line", async () => {
    const { handlers, threads } = await setup();
    await handlers["voice.v1.press"]({ ref: "c1.a2", etag: await etagOf(handlers, "c1") }, VOICE);
    expect(threads.sent[0]?.text).toBe(`${VOICE_PRESSED_PREFIX}\n\n${HOLD_PROMPT}`);
    expect(threads.notes[0]?.note).toContain('heard "Press "Hold" on Fix the flaky login test, web pull request 42?" read back');
  });

  it("refuses a card that changed since its etag, as a conflict", async () => {
    let fleet = voiceFleet();
    const { handlers, threads } = await setup({ fleet: async () => fleet });
    const etag = await etagOf(handlers, "c1");
    const call = fleet.cards[0]!;
    fleet = { ...fleet, cards: [{ ...call, backlog: { ...call.backlog!, hold: "merge web#42 after the second review?" } }, ...fleet.cards.slice(1)] };
    await expect(handlers["voice.v1.press"]({ ref: "c1.a2", etag }, VOICE)).rejects.toMatchObject({ code: "conflict" });
    expect(threads.sent).toEqual([]);
  });

  it("never presses a merge, even with the right etag", async () => {
    const { handlers, threads } = await setup();
    await expect(handlers["voice.v1.press"]({ ref: "c1.a1", etag: await etagOf(handlers, "c1") }, VOICE)).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("never by voice"),
    });
    await expect(handlers["voice.v1.press"]({ ref: "s2", etag: await etagOf(handlers, "s2") }, VOICE)).rejects.toMatchObject({ code: "forbidden" });
    expect(threads.sent).toEqual([]);
  });

  it("takes a pressed suggestion off the board, as the board does", async () => {
    const { handlers, threads, home } = await setup();
    await handlers["voice.v1.press"]({ ref: "s1", etag: await etagOf(handlers, "s1") }, VOICE);
    expect(threads.sent[0]?.text).toBe(`${VOICE_PRESSED_PREFIX}\n\nRun a review loop on https://github.com/you/web/pull/42`);
    const left = await readFile(join(home, "data", "suggestions.md"), "utf8");
    expect(left).not.toContain("Review loop on web#42");
    expect(left).toContain("Land web#42");
  });

  it("refuses a ref that names no button", async () => {
    const { handlers } = await setup();
    await expect(handlers["voice.v1.press"]({ ref: "c1", etag: "x" }, VOICE)).rejects.toMatchObject({ code: "not_found" });
    await expect(handlers["voice.v1.press"]({ ref: "c1.a9", etag: "x" }, VOICE)).rejects.toMatchObject({ code: "not_found" });
  });
});
