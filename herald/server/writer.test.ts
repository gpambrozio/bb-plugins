import { access, readdir, readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanSentence, commandFor, readReply, runCommand, SentenceWriter, SUMMARY_SCHEMA, WRITE_TIMEOUT_MS, type WrittenSentence } from "./writer";
import { recordingLog } from "./testing/fixtures";

/** A command that is a small Node program: real processes, no shell. */
function node(script: string): string[] {
  return [process.execPath, "-e", script, "--"];
}

const ECHO_UPPER = node(`let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(s.toUpperCase()))`);
const SLEEP = node(`setTimeout(()=>{},60000)`);

/**
 * A stand-in for `claude -p … --output-format json --json-schema <schema>`:
 * exits 3 unless given those switches with Herald's schema, then prints a
 * result whose `structured_output` is `structured` (left out when undefined).
 */
function fakeClaude(structured: unknown): string[] {
  const result = { type: "result", subtype: "success", is_error: false, result: JSON.stringify(structured ?? null), structured_output: structured };
  return node(
    `const a=process.argv.slice(1),i=a.indexOf("--json-schema");` +
      `if(a[a.indexOf("--output-format")+1]!=="json"||i<0||a[i+1]!==${JSON.stringify(JSON.stringify(SUMMARY_SCHEMA))})process.exit(3);` +
      `process.stdout.write(${JSON.stringify(JSON.stringify(result))})`,
  );
}

/**
 * A stand-in for `codex exec … --output-schema <file> -`: exits 3 unless the
 * schema file holds Herald's schema and the prompt still comes from stdin,
 * then prints `stdout` as its final message.
 */
function fakeCodex(stdout: string): string[] {
  return [
    ...node(
      `const a=process.argv.slice(1),i=a.indexOf("--output-schema");` +
        `if(i<0||a[a.length-1]!=="-"||require("fs").readFileSync(a[i+1],"utf8")!==${JSON.stringify(JSON.stringify(SUMMARY_SCHEMA))})process.exit(3);` +
        `process.stdout.write(${JSON.stringify(stdout)})`,
    ),
    "-",
  ];
}

/** The sentence a run wrote; fails the test when it chose silence. */
function textOf(written: WrittenSentence): string {
  if (written.kind !== "sentence") throw new Error("expected a sentence, got silence");
  return written.text;
}

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
    expect(cleanSentence('Thinking...\n\n"**Login fix** is done; nothing is left for you."\n')).toEqual({
      kind: "sentence",
      text: "Login fix is done; nothing is left for you.",
    });
  });

  it("cuts a reply that runs on", () => {
    expect(textOf(cleanSentence("word ".repeat(200))).length).toBeLessThanOrEqual(400);
  });

  it("takes a reply with nothing in it as the tool's choice of silence", () => {
    for (const empty of ["", "  \n ", '""', "“ ”", "**", "Thinking...\n\n  ''  \n"]) {
      expect(cleanSentence(empty), JSON.stringify(empty)).toEqual({ kind: "silent" });
    }
  });
});

describe("commandFor", () => {
  it("leaves a plain-text command as it is", () => {
    expect(commandFor(["gemini", "-p", "x"], "text", "/tmp/s.json")).toEqual(["gemini", "-p", "x"]);
  });

  it("asks Claude Code for a JSON result held to the summary schema", () => {
    expect(commandFor(["claude", "-p"], "claude-json", "/tmp/s.json")).toEqual([
      "claude",
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SUMMARY_SCHEMA),
    ]);
  });

  it("gives Codex the schema file before the dash that reads the prompt from stdin", () => {
    expect(commandFor(["codex", "exec", "--color", "never", "-"], "codex-json", "/tmp/s.json")).toEqual([
      "codex",
      "exec",
      "--color",
      "never",
      "--output-schema",
      "/tmp/s.json",
      "-",
    ]);
    expect(commandFor(["codex", "exec"], "codex-json", "/tmp/s.json")).toEqual(["codex", "exec", "--output-schema", "/tmp/s.json"]);
  });

  it("holds every field to the schema, as strict mode needs", () => {
    expect(SUMMARY_SCHEMA.required).toEqual(Object.keys(SUMMARY_SCHEMA.properties));
    expect(SUMMARY_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("readReply", () => {
  const claude = (structured: unknown) => JSON.stringify({ type: "result", is_error: false, structured_output: structured });

  it("reads plain text as before", () => {
    expect(readReply('Thinking...\n\n"Done."', "text")).toEqual({ kind: "sentence", text: "Done." });
    expect(readReply("  \n", "text")).toEqual({ kind: "silent" });
  });

  it("takes the summary, cleaned of markdown and wrapping quotes", () => {
    expect(readReply(claude({ summary: '"**Login fix** is done."' }), "claude-json")).toEqual({ kind: "sentence", text: "Login fix is done." });
    expect(readReply('{"summary":"Login fix is done."}\n', "codex-json")).toEqual({ kind: "sentence", text: "Login fix is done." });
  });

  it("takes a null, empty or blank summary as the tool's choice of silence", () => {
    for (const summary of [null, "", "  \n ", '""', "**"]) {
      expect(readReply(claude({ summary }), "claude-json"), JSON.stringify(summary)).toEqual({ kind: "silent" });
      expect(readReply(JSON.stringify({ summary }), "codex-json"), JSON.stringify(summary)).toEqual({ kind: "silent" });
    }
  });

  it("fails, not silence, on an answer that is not the schema's", () => {
    // Not JSON at all, as a model writing a note instead of an answer would.
    expect(() => readReply("[Empty output: nothing is spoken.]", "codex-json")).toThrow(/did not answer in JSON/);
    expect(() => readReply("", "claude-json")).toThrow(/did not answer in JSON/);
    expect(() => readReply('"hello"', "claude-json")).toThrow(/not a JSON result/);
    // A result with no structured output, or an error result.
    expect(() => readReply(JSON.stringify({ type: "result", is_error: false, result: "hi" }), "claude-json")).toThrow(/not \{ summary \}/);
    expect(() => readReply(JSON.stringify({ type: "result", is_error: true, structured_output: { summary: "x" } }), "claude-json")).toThrow(
      /error/,
    );
    // The wrong shape: no summary, the wrong type, or a field the schema does not have.
    for (const wrong of [{}, { summary: 3 }, { summary: "x", extra: true }, ["x"], "x", null]) {
      expect(() => readReply(claude(wrong), "claude-json"), JSON.stringify(wrong)).toThrow(/not \{ summary \}/);
      expect(() => readReply(JSON.stringify(wrong), "codex-json"), JSON.stringify(wrong)).toThrow(/not \{ summary \}/);
    }
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
    const cwd = textOf(await w.write(node(`require("fs").writeFileSync("seen","");process.stdout.write(process.cwd())`), "p", "text"));
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toContain("herald-writer-");
    // bb's host toolchain adds the usual install folders the server's own PATH may lack.
    const localBin = join(homedir(), ".local", "bin");
    const onPath = node(`process.stdout.write(process.env.PATH.split(":").includes(${JSON.stringify(localBin)}) ? "yes" : "no")`);
    expect(textOf(await w.write(onPath, "p", "text"))).toBe("yes");
    await expect(access(cwd)).rejects.toThrow();
  });

  it("gives every run a fresh empty folder and removes it afterwards", async () => {
    const w = writer();
    const script = node(`process.stdout.write(process.cwd())`);
    const first = textOf(await w.write(script, "p", "text"));
    const second = textOf(await w.write(script, "p", "text"));
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

  it("reaps a tool's own child after the tool answered and exited", async () => {
    const marker = join(tmpdir(), `herald-orphan-${process.pid}-${Date.now()}`);
    const script = node(
      `const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});c.unref();require("fs").writeFileSync(process.env.MARKER,String(c.pid));process.stdout.write("done")`,
    );
    const result = await runCommand(script, "", { cwd: process.cwd(), env: { ...process.env, MARKER: marker }, timeoutMs: 10_000 });
    expect(result.stdout).toBe("done");
    const grandchild = Number(await readFile(marker, "utf8"));
    await unlink(marker);
    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/));
  });

  it("stops a tool that floods its output instead of answering", async () => {
    const flood = node(`setInterval(()=>process.stdout.write("x".repeat(65536)),1)`);
    await expect(runCommand(flood, "", { cwd: process.cwd(), env: process.env, timeoutMs: 10_000 })).rejects.toThrow(/too much output/);
  });

  it("survives a tool that closes its stdin before reading the prompt", async () => {
    const ignoresInput = node(`process.stdin.destroy();setTimeout(()=>process.stdout.write("fine"),50)`);
    expect(textOf(await writer().write(ignoresInput, "x".repeat(200_000), "text"))).toBe("fine");
  });

  it("falls back on a tool that prints progress and then fails", async () => {
    const failing = node(`process.stdout.write("Thinking...");process.stderr.write("boom");process.exit(2)`);
    await expect(writer().write(failing, "p", "text")).rejects.toThrow(/exited with 2: boom/);
  });

  it("returns the cleaned reply", async () => {
    expect(await writer().write(ECHO_UPPER, "login fix is done.", "text")).toEqual({ kind: "sentence", text: "LOGIN FIX IS DONE." });
  });

  it("returns silence for a tool that exits 0 with nothing to say", async () => {
    expect(await writer().write(node(`process.stdout.write("\\n  \\n")`), "p", "text")).toEqual({ kind: "silent" });
  });

  it("fails, not silence, for a tool that exits non-zero with nothing to say", async () => {
    await expect(writer().write(node(`process.exit(1)`), "p", "text")).rejects.toThrow(/exited with 1/);
  });

  it("reads Claude Code's structured summary, and its null or empty summary as silence", async () => {
    expect(await writer().write(fakeClaude({ summary: "Login fix is done." }), "p", "claude-json")).toEqual({
      kind: "sentence",
      text: "Login fix is done.",
    });
    expect(await writer().write(fakeClaude({ summary: null }), "p", "claude-json")).toEqual({ kind: "silent" });
    expect(await writer().write(fakeClaude({ summary: "" }), "p", "claude-json")).toEqual({ kind: "silent" });
  });

  it("fails, not silence, when Claude Code exits 0 without a structured summary", async () => {
    await expect(writer().write(fakeClaude(undefined), "p", "claude-json")).rejects.toThrow(/not \{ summary \}/);
    await expect(writer().write(fakeClaude({ sentence: "hi" }), "p", "claude-json")).rejects.toThrow(/not \{ summary \}/);
  });

  it("gives Codex the schema in a file of the run's own and reads its summary", async () => {
    expect(await writer().write(fakeCodex('{"summary":"Login fix is done."}'), "p", "codex-json")).toEqual({
      kind: "sentence",
      text: "Login fix is done.",
    });
    expect(await writer().write(fakeCodex('{"summary":null}'), "p", "codex-json")).toEqual({ kind: "silent" });
    expect(await writer().write(fakeCodex('{"summary":""}'), "p", "codex-json")).toEqual({ kind: "silent" });
  });

  it("fails, not silence, when Codex exits 0 with an answer that is not the schema's", async () => {
    await expect(writer().write(fakeCodex(""), "p", "codex-json")).rejects.toThrow(/did not answer in JSON/);
    await expect(writer().write(fakeCodex("[Empty output: nothing is spoken.]"), "p", "codex-json")).rejects.toThrow(/did not answer in JSON/);
    await expect(writer().write(fakeCodex('{"text":"hi"}'), "p", "codex-json")).rejects.toThrow(/not \{ summary \}/);
  });

  it("removes Codex's schema file with the run's folder", async () => {
    const seen = node(
      `const a=process.argv.slice(1);process.stdout.write(JSON.stringify({summary:a[a.indexOf("--output-schema")+1]}))`,
    );
    const written = await writer().write([...seen, "-"], "p", "codex-json");
    const schemaPath = textOf(written);
    expect(schemaPath).toContain("herald-writer-");
    await expect(access(schemaPath)).rejects.toThrow();
  });

  it("refuses a third run while two are still going, rather than queueing", async () => {
    const w = writer();
    const first = w.write(SLEEP, "", "text").catch((error: unknown) => error);
    const second = w.write(SLEEP, "", "text").catch((error: unknown) => error);
    await expect(w.write(ECHO_UPPER, "x", "text")).rejects.toThrow(/busy/);
    await w.dispose();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
  });

  it("has a timeout a slow tool cannot exceed", () => {
    expect(WRITE_TIMEOUT_MS).toBe(45_000);
  });
});
