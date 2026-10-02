import { access, readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("runs the command in a folder of its own under the temp directory, with the usual tool paths", async () => {
    const w = writer();
    const cwd = await w.write(node(`require("fs").writeFileSync("seen","");process.stdout.write(process.cwd())`), "p");
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toContain("herald-writer-");
    const onPath = node(`process.stdout.write(process.env.PATH.split(":").includes("/opt/homebrew/bin") ? "yes" : "no")`);
    expect(await w.write(onPath, "p")).toBe("yes");
    await expect(access(cwd)).rejects.toThrow();
  });

  it("gives every run a fresh empty folder and removes it afterwards", async () => {
    const w = writer();
    const script = node(`process.stdout.write(process.cwd())`);
    const first = await w.write(script, "p");
    const second = await w.write(script, "p");
    expect(first).not.toBe(second);
    await expect(access(first)).rejects.toThrow();
    await expect(access(second)).rejects.toThrow();
  });

  it("kills the tool's own children when it times out", async () => {
    const w = writer();
    const marker = join(tmpdir(), `herald-grandchild-${process.pid}-${Date.now()}`);
    // A tool that starts a child of its own and then hangs; the child's pid goes to a file.
    const script = node(
      `const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});require("fs").writeFileSync(process.env.MARKER,String(c.pid));setTimeout(()=>{},60000)`,
    );
    await expect(
      runCommand(script, "", { cwd: process.cwd(), env: { ...process.env, MARKER: marker }, timeoutMs: 1_500 }),
    ).rejects.toThrow(/did not finish/);
    const grandchild = Number(await readFile(marker, "utf8"));
    await unlink(marker);
    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/));
    await w.dispose();
  });

  it("stops a tool that floods its output instead of answering", async () => {
    const flood = node(`setInterval(()=>process.stdout.write("x".repeat(65536)),1)`);
    await expect(runCommand(flood, "", { cwd: process.cwd(), env: process.env, timeoutMs: 10_000 })).rejects.toThrow(/too much output/);
  });

  it("survives a tool that closes its stdin before reading the prompt", async () => {
    const ignoresInput = node(`process.stdin.destroy();setTimeout(()=>process.stdout.write("fine"),50)`);
    expect(await writer().write(ignoresInput, "x".repeat(200_000))).toBe("fine");
  });

  it("falls back on a tool that prints progress and then fails", async () => {
    const failing = node(`process.stdout.write("Thinking...");process.stderr.write("boom");process.exit(2)`);
    await expect(writer().write(failing, "p")).rejects.toThrow(/exited with 2: boom/);
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
    expect(WRITE_TIMEOUT_MS).toBe(45_000);
  });
});
