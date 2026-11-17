/**
 * `bb herald` against fake deps, through the SDK's CLI harness: what each
 * command prints, with and without `--json`, and what it refuses.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import type { ChoiceOption } from "../shared/thread-choice";
import { heraldCli, UnknownThreadError, type HeraldCliDeps, type ThreadChoiceReport } from "./cli";

const KNOWN = "thr_known";
const WORKER = "thr_worker";

function fakeDeps(start: { muted?: boolean } = {}) {
  const state = { muted: start.muted ?? false, own: new Map<string, ChoiceOption>(), sets: [] as Array<[string, ChoiceOption]> };
  const report = (threadId: string): ThreadChoiceReport => {
    if (threadId !== KNOWN && threadId !== WORKER) throw new UnknownThreadError(threadId);
    const own = state.own.get(threadId) ?? "default";
    if (own !== "default") return { threadId, own, effective: own, source: "self", fromThreadId: null };
    const parent = threadId === WORKER ? state.own.get(KNOWN) : undefined;
    if (parent !== undefined && parent !== "default") return { threadId, own, effective: parent, source: "parent", fromThreadId: KNOWN };
    return { threadId, own, effective: "announce", source: "default", fromThreadId: null };
  };
  const deps: HeraldCliDeps = {
    mute: {
      muted: async () => state.muted,
      set: async (muted) => {
        const changed = state.muted !== muted;
        state.muted = muted;
        return { muted, changed };
      },
    },
    threads: {
      show: async (threadId) => report(threadId),
      set: async (threadId, option) => {
        report(threadId);
        state.sets.push([threadId, option]);
        if (option === "default") state.own.delete(threadId);
        else state.own.set(threadId, option);
        return report(threadId);
      },
    },
  };
  return { state, deps };
}

function cli(start: { muted?: boolean } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "herald" });
  const fake = fakeDeps(start);
  bb.cli.register(heraldCli(fake.deps));
  return { run: (argv: string[]) => harness.runCli(argv), state: fake.state };
}

describe("bb herald mute, unmute and status", () => {
  it("mutes, says so, and says so again on a repeat without changing anything", async () => {
    const { run, state } = cli();
    const first = await run(["mute"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Herald is muted");
    expect(state.muted).toBe(true);
    const again = await run(["mute"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/^Already muted\./);
  });

  it("unmutes, and a repeat is fine", async () => {
    const { run, state } = cli({ muted: true });
    expect((await run(["unmute"])).stdout).toContain("Herald is unmuted");
    expect(state.muted).toBe(false);
    const again = await run(["unmute"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/^Already unmuted\./);
  });

  it("prints JSON with --json", async () => {
    const { run } = cli();
    expect(JSON.parse((await run(["mute", "--json"])).stdout)).toEqual({ muted: true, changed: true });
    expect(JSON.parse((await run(["mute", "--json"])).stdout)).toEqual({ muted: true, changed: false });
    expect(JSON.parse((await run(["status", "--json"])).stdout)).toEqual({ muted: true });
    expect(JSON.parse((await run(["unmute", "--json"])).stdout)).toEqual({ muted: false, changed: true });
    expect(JSON.parse((await run(["status", "--json"])).stdout)).toEqual({ muted: false });
  });

  it("says whether Herald is muted", async () => {
    expect((await cli().run(["status"])).stdout).toBe("Herald is not muted.\n");
    expect((await cli({ muted: true }).run(["status"])).stdout).toContain("Herald is muted");
  });
});

describe("bb herald thread", () => {
  it("shows a thread's own choice and the one that applies", async () => {
    const { run } = cli();
    const shown = await run(["thread", KNOWN]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toBe(`${KNOWN}: default\nEffective: announce (Herald's default)\n`);
  });

  it("sets each choice, spelling Questions only as questions-only", async () => {
    const { run, state } = cli();
    const set = await run(["thread", KNOWN, "questions-only"]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toBe(`${KNOWN}: questions-only\nEffective: questions-only (its own choice)\n`);
    expect(state.sets).toEqual([[KNOWN, "questions"]]);
    for (const [value, option] of [["silent", "silent"], ["announce", "announce"], ["default", "default"]] as const) {
      expect((await run(["thread", KNOWN, value])).exitCode).toBe(0);
      expect(state.sets.at(-1)).toEqual([KNOWN, option]);
    }
    expect(state.own.has(KNOWN)).toBe(false);
  });

  it("names the thread a choice is inherited from", async () => {
    const { run } = cli();
    await run(["thread", KNOWN, "silent"]);
    expect((await run(["thread", WORKER])).stdout).toBe(`${WORKER}: default\nEffective: silent (following the thread that started it, ${KNOWN})\n`);
    expect(JSON.parse((await run(["thread", WORKER, "--json"])).stdout)).toEqual({
      threadId: WORKER,
      choice: "default",
      effective: { choice: "silent", source: "parent", fromThreadId: KNOWN },
    });
  });

  it("prints JSON with --json, the CLI's spelling included", async () => {
    const { run } = cli();
    expect(JSON.parse((await run(["thread", KNOWN, "questions-only", "--json"])).stdout)).toEqual({
      threadId: KNOWN,
      choice: "questions-only",
      effective: { choice: "questions-only", source: "self", fromThreadId: null },
    });
  });

  it("refuses an unknown value before touching the thread", async () => {
    const { run, state } = cli();
    const result = await run(["thread", KNOWN, "questions"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('"questions" is not a Herald choice. Use one of: default, announce, questions-only, silent.');
    expect(state.sets).toEqual([]);
    const json = await run(["thread", KNOWN, "loud", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: "invalid_value" } });
  });

  it("refuses an unknown thread, to show or to set", async () => {
    const { run, state } = cli();
    for (const argv of [["thread", "thr_nope"], ["thread", "thr_nope", "silent"]]) {
      const result = await run(argv);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("bb has no thread thr_nope.");
    }
    expect(state.sets).toEqual([]);
    expect(JSON.parse((await run(["thread", "thr_nope", "--json"])).stdout)).toMatchObject({ ok: false, error: { code: "thread_not_found" } });
  });

  it("needs a thread id", async () => {
    const result = await cli().run(["thread"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("thread-id");
  });
});
