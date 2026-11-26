/**
 * Reading and running commands in a tab, against a scripted shell: bb's kept
 * output is a list of chunks the test appends to, typed input is recorded,
 * and the clock is manual. The output is replayed into a real headless xterm.
 */
import { describe, expect, it } from "vitest";

import {
  QUIET_MS,
  TerminalToolError,
  checkCommand,
  readTerminal,
  runCommand,
  type AgentTerminalPorts,
  type SessionFacts,
  type TabFacts,
} from "./terminal-agent";

const BEL = "\u0007";
const osc = (body: string) => `\u001b]${body}${BEL}`;
const prompt = () => `${osc("133;A")}~/app % ${osc("133;B")}`;

const TAB: TabFacts = { terminalId: "term_1", label: "Mac mini", hostName: "Mac mini" };

/**
 * A shell whose output the test scripts. `respond` answers each line typed
 * into it: what the shell prints back, now or after some milliseconds.
 */
function shell(options: {
  session?: Partial<SessionFacts> | null;
  respond?: (line: string) => { after?: number; output: string }[];
} = {}) {
  const chunks: { seq: number; dataBase64: string }[] = [];
  const typed: string[] = [];
  const announced: string[] = [];
  const prompts: string[] = [];
  let clock = 0;
  const timers: { at: number; output: string }[] = [];
  const print = (text: string) => chunks.push({ seq: chunks.length, dataBase64: Buffer.from(text).toString("base64") });
  const session: SessionFacts | null =
    options.session === null ? null : { cols: 80, rows: 24, status: "running", exitCode: null, ...options.session };
  const ports: AgentTerminalPorts = {
    session: async () => session,
    output: async ({ sinceSeq, tailBytes }) => {
      const from = tailBytes !== undefined ? 0 : (sinceSeq ?? 0);
      return { chunks: chunks.filter((chunk) => chunk.seq >= from), nextSeq: chunks.length };
    },
    input: async (_terminalId, data) => {
      typed.push(data);
      for (const reply of options.respond?.(data.replace(/\r$/, "")) ?? []) {
        if ((reply.after ?? 0) === 0) print(reply.output);
        else timers.push({ at: clock + reply.after!, output: reply.output });
      }
    },
    announce: (_terminalId, command, prompt) => {
      announced.push(command);
      prompts.push(prompt);
    },
    sleep: async (ms) => {
      clock += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= clock) print(timer.output);
        else timers.push(timer);
      }
    },
    now: () => clock,
  };
  return { ports, print, typed, announced, prompts, elapsed: () => clock };
}

const never = new AbortController().signal;

describe("readTerminal", () => {
  it("reads what the terminal shows, where the shell is, and how the last command ended", async () => {
    const { ports, print } = shell();
    print(osc("7;file://mini/Users/me/app") + prompt() + "npm test\r\n" + osc("133;C") + "Error: 2 failed\r\n" + osc("133;D;1") + prompt());
    const text = await readTerminal(ports, TAB);
    expect(text).toContain('Terminal "Mac mini": the user\'s own interactive shell. Its directory is /Users/me/app.');
    expect(text).toContain("The shell is at its prompt.");
    expect(text).toContain("The last command, `npm test`, failed with exit code 1.");
    expect(text).toContain("~/app % npm test\nError: 2 failed\n~/app %");
  });

  it("says when the shell reports nothing, and names a renamed tab's machine", async () => {
    const { ports, print } = shell();
    print("me@mini ~ % ls\r\nnotes.txt\r\nme@mini ~ % ");
    const text = await readTerminal(ports, { ...TAB, label: "build" });
    expect(text).toContain('Terminal "build" on Mac mini');
    expect(text).toContain("no OSC 133 shell integration");
    expect(text).toContain("notes.txt");
  });

  it("refuses a shell that has ended or whose machine is offline", async () => {
    await expect(readTerminal(shell({ session: { status: "exited" } }).ports, TAB)).rejects.toThrow(/has ended/);
    await expect(readTerminal(shell({ session: null }).ports, TAB)).rejects.toThrow(/has ended/);
    await expect(readTerminal(shell({ session: { status: "disconnected" } }).ports, TAB)).rejects.toThrow(/offline/);
  });
});

describe("checkCommand", () => {
  it("takes one line of input and refuses newlines and control characters", () => {
    expect(checkCommand("  git status  ")).toBe("git status");
    expect(() => checkCommand("")).toThrow(TerminalToolError);
    expect(() => checkCommand("ls\nrm -rf /")).toThrow(/one line/);
    expect(() => checkCommand("ls\u0003")).toThrow(/one line/);
    expect(() => checkCommand("x".repeat(4001))).toThrow(/longer/);
  });
});

describe("runCommand", () => {
  /** A zsh with OSC 133 marks: echoes the line, runs it, prints its output and exit status, and prompts again. */
  const integrated = (outputs: Record<string, { output: string; code: number; after?: number }>) => (line: string) => {
    const result = outputs[line] ?? { output: `zsh: command not found: ${line}\r\n`, code: 127 };
    return [
      { output: `${line}\r\n${osc("133;C")}` },
      { after: result.after ?? 0, output: `${result.output}${osc(`133;D;${result.code}`)}${prompt()}` },
    ];
  };

  it("types the command, waits for the shell to say it finished, and returns its output and exit code", async () => {
    const terminal = shell({ respond: integrated({ "npm test": { output: "> test\r\nError: 2 failed\r\n", code: 1, after: 2_000 } }) });
    terminal.print(prompt());
    const text = await runCommand(terminal.ports, TAB, { command: "npm test" }, never);
    expect(terminal.typed).toEqual(["npm test\r"]);
    expect(terminal.announced).toEqual(["npm test"]);
    // With the prompt it was typed at, so the page can tell the user's prompt from a command's question.
    expect(terminal.prompts).toEqual(["~/app % "]);
    expect(text).toContain('Ran `npm test` in "Mac mini": it failed with exit code 1.');
    expect(text).toContain("> test\nError: 2 failed");
  });

  it("leaves a command that outlasts the wait running, and says so", async () => {
    const terminal = shell({ respond: integrated({ "sleep 100": { output: "", code: 0, after: 100_000 } }) });
    terminal.print(prompt());
    const text = await runCommand(terminal.ports, TAB, { command: "sleep 100", timeoutMs: 5_000 }, never);
    expect(text).toContain("still running after 5 s");
    expect(terminal.elapsed()).toBeLessThan(6_000);
  });

  it("types nothing while a command runs, into a full-screen program, or over the user's own typing", async () => {
    const running = shell();
    running.print(prompt() + "make\r\n" + osc("133;C") + "compiling…\r\n");
    await expect(runCommand(running.ports, TAB, { command: "ls" }, never)).rejects.toThrow(/still running/);

    const editor = shell();
    editor.print(prompt() + "vim\r\n" + osc("133;C") + "\u001b[?1049h");
    await expect(runCommand(editor.ports, TAB, { command: "ls" }, never)).rejects.toThrow(/full-screen/);

    const typing = shell();
    typing.print(prompt() + "git sta");
    await expect(runCommand(typing.ports, TAB, { command: "ls" }, never)).rejects.toThrow(/has typed something.*"git sta"/);

    for (const terminal of [running, editor, typing]) expect(terminal.typed).toEqual([]);
  });

  it("types into a shell whose marks stopped (an ended ssh session left a command running), and reads it back once quiet", async () => {
    const local = `${osc("7;file://mac/Users/me/app")}╭─me@mac ~/app\r\n╰─$ `;
    const terminal = shell({
      respond: (line) => [{ output: `${line}\r\n` }, { after: 300, output: `COMMAND PID\r\nnode 4242\r\n${local}` }],
    });
    terminal.print(local + "ssh nas\r\n" + prompt() + "exit\r\n" + osc("133;C") + "Connection to nas closed.\r\n" + local);
    expect(await readTerminal(terminal.ports, TAB)).toContain("This shell stopped reporting its prompt and exit codes");
    const text = await runCommand(terminal.ports, TAB, { command: "lsof -nP -iTCP -sTCP:LISTEN" }, never);
    expect(terminal.typed).toEqual(["lsof -nP -iTCP -sTCP:LISTEN\r"]);
    expect(text).toContain("once its output went quiet");
    expect(text).toContain("node 4242");
  });

  it("without shell integration, returns the terminal once the output has gone quiet", async () => {
    const terminal = shell({
      respond: (line) => [{ output: `${line}\r\n` }, { after: 500, output: "notes.txt\r\nme@mini ~ % " }],
    });
    terminal.print("me@mini ~ % ");
    const text = await runCommand(terminal.ports, TAB, { command: "ls" }, never);
    expect(text).toContain("does not report when a command finishes or its exit code");
    expect(text).toContain("once its output went quiet");
    expect(text).toContain("```text\nls\nnotes.txt\nme@mini ~ %\n```");
    expect(terminal.elapsed()).toBeGreaterThanOrEqual(QUIET_MS);
    expect(terminal.elapsed()).toBeLessThan(QUIET_MS + 1_000);
  });

  it("stops waiting when the call is cancelled", async () => {
    const terminal = shell({ respond: integrated({ "sleep 100": { output: "", code: 0, after: 100_000 } }) });
    terminal.print(prompt());
    const controller = new AbortController();
    const sleep = terminal.ports.sleep;
    terminal.ports.sleep = async (ms, signal) => {
      controller.abort();
      await sleep(ms, signal);
    };
    await expect(runCommand(terminal.ports, TAB, { command: "sleep 100" }, controller.signal)).rejects.toThrow(/Stopped/);
  });
});
