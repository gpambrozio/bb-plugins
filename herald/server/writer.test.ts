import { access, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { cleanSentence, runCommand, SentenceWriter, WRITE_TIMEOUT_MS } from "./writer";
import { recordingLog } from "./testing/fixtures";

/** A command that is a small Node program: real processes, no shell. */
function node(script: string): string[] {
  return [process.execPath, "-e", script];
}

const ECHO_UPPER = node(`let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(s.toUpperCase()))`);
const SLEEP = node(`setTimeout(()=>{},60000)`);

describe("runCommand", () => {
  it("feeds the input on stdin and returns what the process wrote", async () => {
    const result = await runCommand(ECHO_UPPER, "hello", { cwd: process.cwd(), env: process.env, timeoutMs: 10_000 });
    expect(result).toEqual({ code: 0, stdout: "HELLO", stderr: "" });
  });

  it("kills a process that outlives the timeout", async () => {
    await expect(runCommand(SLEEP, "", { cwd: process.cwd(), env: process.env, timeoutMs: 200 })).rejects.toThrow(/did not finish within/);
  });

  it("kills the process when aborted", async () => {
    const controller = new AbortController();
    const run = runCommand(SLEEP, "", { cwd: process.cwd(), env: process.env, timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toThrow(/aborted/);
  });

  it("names a command that does not exist", async () => {
    await expect(runCommand(["herald-no-such-tool-xyz"], "", { cwd: process.cwd(), env: process.env, timeoutMs: 1_000 })).rejects.toThrow(
      /herald-no-such-tool-xyz/,
    );
  });
});

describe("cleanSentence", () => {
  it("keeps the last paragraph as one plain line without wrapping quotes", () => {
    expect(cleanSentence('Thinking...\n\n"**Login fix** is done; nothing is left for you."\n')).toBe("Login fix is done; nothing is left for you.");
  });

  it("cuts a reply that runs on, and refuses one with nothing in it", () => {
    expect(cleanSentence("word ".repeat(200)).length).toBeLessThanOrEqual(400);
    expect(() => cleanSentence("  \n ")).toThrow(/empty/);
  });
});

describe("SentenceWriter", () => {
  const writers: SentenceWriter[] = [];
  afterEach(async () => {
    for (const writer of writers.splice(0)) await writer.dispose();
  });

  function writer(): SentenceWriter {
    const created = new SentenceWriter(recordingLog());
    writers.push(created);
    return created;
  }

  it("runs the command in an empty folder of its own, with the usual tool paths, and removes it on dispose", async () => {
    const w = writer();
    const cwd = await w.write(node(`process.stdout.write(process.cwd())`), "p");
    expect(cwd).not.toBe(process.cwd());
    expect(await readdir(cwd)).toEqual([]);
    const onPath = node(`process.stdout.write(process.env.PATH.split(":").includes("/opt/homebrew/bin") ? "yes" : "no")`);
    expect(await w.write(onPath, "p")).toBe("yes");
    await w.dispose();
    await expect(access(cwd)).rejects.toThrow();
  });

  it("returns the cleaned reply", async () => {
    expect(await writer().write(ECHO_UPPER, "login fix is done.")).toBe("LOGIN FIX IS DONE.");
  });

  it("refuses a third run while two are still going, rather than queueing", async () => {
    const w = writer();
    const first = w.write(SLEEP, "").catch((error: unknown) => error);
    const second = w.write(SLEEP, "").catch((error: unknown) => error);
    await expect(w.write(ECHO_UPPER, "x")).rejects.toThrow(/busy/);
    await w.dispose();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
  });

  it("has a timeout a slow tool cannot exceed", () => {
    expect(WRITE_TIMEOUT_MS).toBe(20_000);
  });
});
