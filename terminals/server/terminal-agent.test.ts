/**
 * Reading and running commands in a tab, against a scripted shell: bb's kept
 * output is a list of chunks the test appends to, typed input is recorded,
 * and the clock is manual. The output is replayed into a real headless xterm.
 */
import { describe, expect, it } from "vitest";

import {
  ECHO_TIMEOUT_MS,
  QUIET_MS,
  TerminalLocks,
  TerminalToolError,
  checkCommand,
  readTerminal,
  runCommand,
  type AgentTerminalPorts,
  type RunContext,
  type SessionFacts,
  type TabFacts,
} from "./terminal-agent";

const BEL = "\u0007";
const DEL = "\u007f";
const osc = (body: string) => `\u001b]${body}${BEL}`;
const prompt = () => `${osc("133;A")}~/app % ${osc("133;B")}`;
/** The owner's zsh: no OSC 133 marks; oh-my-zsh reports the directory, then a two-line prompt. */
const ownerPrompt = `${osc("7;file://mac/Users/me/app")}\r\n╭─me@mac ~/app ‹main›\r\n╰─$ `;

const TAB: TabFacts = { terminalId: "term_1", label: "Mac mini", hostName: "Mac mini" };

type Reply = { after?: number; output: string };

/**
 * A shell whose output the test scripts. What is typed is echoed (unless
 * `echo` is false) and a DEL erases a character, as a line editor does; on
 * Enter, `respond` answers the line: what the shell prints back, now or after
 * some milliseconds.
 */
function shell(
  options: {
    session?: Partial<SessionFacts> | null;
    respond?: (line: string) => Reply[];
    echo?: boolean;
    /** Runs as each piece of input arrives, before it is echoed: the user typing at the same moment, say. */
    onInput?: (data: string) => void;
  } = {},
) {
  const chunks: { seq: number; dataBase64: string }[] = [];
  const typed: string[] = [];
  const announced: string[] = [];
  let clock = 0;
  let line = "";
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
      options.onInput?.(data);
      if (data === "\r") {
        const entered = line;
        line = "";
        for (const reply of options.respond?.(entered) ?? []) {
          if ((reply.after ?? 0) === 0) print(reply.output);
          else timers.push({ at: clock + reply.after!, output: reply.output });
        }
      } else if (/^\u007f+$/.test(data)) {
        line = line.slice(0, Math.max(0, line.length - data.length));
        if (options.echo !== false) print("\b \b".repeat(data.length));
      } else {
        line += data;
        if (options.echo !== false) print(data);
      }
    },
    announce: (_terminalId, command) => void announced.push(command),
    sleep: async (ms) => {
      clock += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= clock) print(timer.output);
        else timers.push(timer);
      }
    },
    now: () => clock,
  };
  return { ports, print, typed, announced, elapsed: () => clock };
}

const never = new AbortController().signal;

function context(overrides: Partial<RunContext> = {}): RunContext {
  return { signal: never, checkAccess: () => {}, locks: new TerminalLocks(), ...overrides };
}

/** A zsh with OSC 133 marks: on Enter, runs the line, prints its output and exit status, and prompts again. */
const integrated = (outputs: Record<string, { output: string; code: number; after?: number }>) => (line: string) => {
  const result = outputs[line] ?? { output: `zsh: command not found: ${line}\r\n`, code: 127 };
  return [
    { output: `\r\n${osc("133;C")}` },
    { after: result.after ?? 0, output: `${result.output}${osc(`133;D;${result.code}`)}${prompt()}` },
  ];
};

/** The owner's zsh without marks: on Enter, prints the output, then its prompt. */
const plain = (outputs: Record<string, string>, after = 300) => (line: string) => [
  { output: "\r\n" },
  { after, output: `${outputs[line] ?? ""}${ownerPrompt}` },
];

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
    expect(text).toContain("does not show an empty shell prompt");
    expect(text).toContain("notes.txt");
  });

  it("says an unmarked shell shows its prompt, empty, when it does", async () => {
    const { ports, print } = shell();
    print(ownerPrompt);
    expect(await readTerminal(ports, TAB)).toContain("The terminal shows its prompt, empty.");
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
  it("types the command, presses Enter once it is echoed, and returns its output and exit code", async () => {
    const terminal = shell({ respond: integrated({ "npm test": { output: "> test\r\nError: 2 failed\r\n", code: 1, after: 2_000 } }) });
    terminal.print(prompt());
    const text = await runCommand(terminal.ports, TAB, { command: "npm test" }, context());
    expect(terminal.typed).toEqual(["npm test", "\r"]);
    expect(terminal.announced).toEqual(["npm test"]);
    expect(text).toContain('Ran `npm test` in "Mac mini": it failed with exit code 1.');
    expect(text).toContain("> test\nError: 2 failed");
  });

  it("leaves a command that outlasts the wait running, and says so", async () => {
    const terminal = shell({ respond: integrated({ "sleep 100": { output: "", code: 0, after: 100_000 } }) });
    terminal.print(prompt());
    const text = await runCommand(terminal.ports, TAB, { command: "sleep 100", timeoutMs: 5_000 }, context());
    expect(text).toContain("still running after 5 s");
    expect(terminal.elapsed()).toBeLessThan(6_000);
  });

  it("reports the exit code of a command whose output outgrew the scrollback", async () => {
    const lines = Array.from({ length: 12_000 }, (_, index) => `line ${index + 1}`).join("\r\n");
    const terminal = shell({ respond: integrated({ "make all": { output: `${lines}\r\nmake: *** Error 2\r\n`, code: 2, after: 1_000 } }) });
    terminal.print(prompt());
    const text = await runCommand(terminal.ports, TAB, { command: "make all" }, context());
    expect(text).toContain("it failed with exit code 2");
    expect(text).toContain("The last lines it printed");
    expect(text).toContain("make: *** Error 2");
    expect(terminal.elapsed()).toBeLessThan(2_000);
  });

  it("types nothing while a command runs, into a full-screen program, or over the user's own typing", async () => {
    const running = shell();
    running.print(prompt() + "make\r\n" + osc("133;C") + "compiling…\r\n");
    await expect(runCommand(running.ports, TAB, { command: "ls" }, context())).rejects.toThrow(/still running/);

    const editor = shell();
    editor.print(prompt() + "vim\r\n" + osc("133;C") + "\u001b[?1049h");
    await expect(runCommand(editor.ports, TAB, { command: "ls" }, context())).rejects.toThrow(/full-screen/);

    const typing = shell();
    typing.print(prompt() + "git sta");
    await expect(runCommand(typing.ports, TAB, { command: "ls" }, context())).rejects.toThrow(/has typed something.*"git sta"/);

    for (const terminal of [running, editor, typing]) expect(terminal.typed).toEqual([]);
  });

  it("sees the user's typing when the cursor was moved back to the start of it, or into it", async () => {
    // Ctrl-A (or Home), or a recalled history entry with the cursor moved left.
    const start = shell();
    start.print(prompt() + "echo OWNER\u001b[10D");
    await expect(runCommand(start.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/has typed something.*"echo OWNER"/);

    const middle = shell();
    middle.print(prompt() + "echo OWNER\u001b[5D");
    await expect(runCommand(middle.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/has typed something.*"echo OWNER"/);

    const unmarked = shell();
    unmarked.print(ownerPrompt + "echo OWNER\u001b[10D");
    await expect(runCommand(unmarked.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/has typed something.*"echo OWNER"/);

    for (const terminal of [start, middle, unmarked]) expect(terminal.typed).toEqual([]);
  });

  it("still types at a prompt with a right-hand prompt (zsh's RPROMPT) beside the cursor", async () => {
    const terminal = shell({ respond: integrated({ pwd: { output: "/Users/me/app\r\n", code: 0 } }) });
    // As zsh draws it: clear the line, jump the cursor right, the right prompt, jump back.
    terminal.print(prompt() + "\u001b[K\u001b[68C1 ↵\u001b[71D");
    expect(await runCommand(terminal.ports, TAB, { command: "pwd" }, context())).toContain("it succeeded (exit code 0)");
  });

  it("runs at the owner's oh-my-zsh prompt with its right-hand exit code, as zsh drew it", async () => {
    // Recorded from zsh 5.9 with PROMPT's two lines and RPROMPT='1 ↵', in 60 columns.
    const drawn = `${osc("7;file://mac/Users/me/app")}\r\n╭─me@mac ~/app ‹main›\r\n╰─$ \u001b[K\u001b[52C1 ↵\u001b[55D\u001b[?2004h \b`;
    const terminal = shell({ session: { cols: 60 }, respond: plain({ pwd: "/Users/me/app\r\n" }) });
    terminal.print(drawn);
    expect(await runCommand(terminal.ports, TAB, { command: "pwd" }, context())).toContain("/Users/me/app");
    expect(terminal.typed).toEqual(["pwd", "\r"]);

    // The same prompt with the user's text, indented, the cursor back at its start (Ctrl-A).
    const typing = shell({ session: { cols: 60 } });
    typing.print(`${drawn}  echo OWNER\u001b[12D`);
    await expect(runCommand(typing.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/has typed something.*"echo OWNER"/);
    expect(typing.typed).toEqual([]);
  });

  it("does not take the user's text reaching the right edge for a right-hand prompt", async () => {
    const terminal = shell();
    terminal.print(`${osc("133;A")}$ ${osc("133;B")}  ${"x".repeat(75)}\u001b[77D`);
    await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/has typed something/);
    expect(terminal.typed).toEqual([]);
  });

  describe("in a shell without marks", () => {
    it("runs at the owner's zsh prompt (a directory report, then a two-line prompt) and reads it back once quiet", async () => {
      const terminal = shell({ respond: plain({ ls: "notes.txt\r\n" }, 500) });
      terminal.print("me@mac ~/app % make\r\nbuilt\r\n" + ownerPrompt);
      const text = await runCommand(terminal.ports, TAB, { command: "ls" }, context());
      expect(terminal.typed).toEqual(["ls", "\r"]);
      expect(text).toContain("does not report when a command finishes or its exit code");
      expect(text).toContain("once its output went quiet");
      expect(text).toContain("```text\nls\nnotes.txt\n\n╭─me@mac ~/app ‹main›\n╰─$\n```");
      expect(terminal.elapsed()).toBeGreaterThanOrEqual(QUIET_MS);
      expect(terminal.elapsed()).toBeLessThan(QUIET_MS + 1_000);
    });

    it("types into a shell whose marks stopped (an ended ssh session left a command running)", async () => {
      const terminal = shell({ respond: plain({ "lsof -nP -iTCP -sTCP:LISTEN": "COMMAND PID\r\nnode 4242\r\n" }) });
      terminal.print(ownerPrompt + "ssh nas\r\n" + prompt() + "exit\r\n" + osc("133;C") + "Connection to nas closed.\r\n" + ownerPrompt);
      expect(await readTerminal(terminal.ports, TAB)).toContain("This shell stopped reporting its prompt and exit codes");
      const text = await runCommand(terminal.ports, TAB, { command: "lsof -nP -iTCP -sTCP:LISTEN" }, context());
      expect(terminal.typed).toEqual(["lsof -nP -iTCP -sTCP:LISTEN", "\r"]);
      expect(text).toContain("node 4242");
    });

    it("types nothing at a password prompt, and says how to fix it", async () => {
      const terminal = shell();
      terminal.print(ownerPrompt + "sudo -k id\r\nPassword:");
      const refusal = runCommand(terminal.ports, TAB, { command: "pwd" }, context());
      await expect(refusal).rejects.toThrow(/does not plainly show its shell waiting at an empty prompt/);
      await expect(refusal).rejects.toThrow(/To fix it:.*shell integration/);
      expect(terminal.typed).toEqual([]);
    });

    it("types nothing when the terminal shows only a command's output (its prompt scrolled out of what bb keeps)", async () => {
      const terminal = shell();
      terminal.print(Array.from({ length: 50 }, (_, index) => `compiling module ${index}`).join("\r\n") + "\r\n");
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/does not plainly show/);
      expect(terminal.typed).toEqual([]);
    });

    it("types nothing at a prompt-like line the shell did not draw after reporting its directory", async () => {
      // A prompt that looks right, but the shell never reported its directory.
      const unreported = shell();
      unreported.print("me@mini ~ % ");
      await expect(runCommand(unreported.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/does not plainly show/);

      // A REPL started from the prompt, with no banner.
      const repl = shell();
      repl.print(ownerPrompt + "redis-cli\r\n127.0.0.1:6379> ");
      await expect(runCommand(repl.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/does not plainly show/);

      // Typed ahead while the last command ran, ending like a prompt.
      const typedAhead = shell();
      typedAhead.print(ownerPrompt + "echo $ ");
      await expect(runCommand(typedAhead.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/does not plainly show/);

      for (const terminal of [unreported, repl, typedAhead]) expect(terminal.typed).toEqual([]);
    });

    it("does not take a directory report during a running command as the end of it", async () => {
      // With marks: the command ran (`C`), then something printed OSC 7 and a password prompt.
      const reported = shell();
      reported.print(prompt() + "ssh nas\r\n" + osc("133;C") + osc("7;file://nas/home/me") + "me@nas's password: ");
      await expect(runCommand(reported.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/does not plainly show/);

      // An OSC 7 that names no directory says nothing: the command still runs.
      const invalid = shell();
      invalid.print(prompt() + "make\r\n" + osc("133;C") + osc("7;not a url") + "$ ");
      await expect(runCommand(invalid.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/still running/);

      for (const terminal of [reported, invalid]) expect(terminal.typed).toEqual([]);
    });
  });

  describe("racing the user and other calls", () => {
    it("keeps a cancelled waiter's place: a later call does not enter while the first still runs", async () => {
      const locks = new TerminalLocks();
      const events: string[] = [];
      let releaseA = () => {};
      const a = locks.run("term_1", never, async () => {
        events.push("A entered");
        await new Promise<void>((resolve) => (releaseA = resolve));
        events.push("A left");
      });
      const cancelB = new AbortController();
      const b = locks.run("term_1", cancelB.signal, async () => void events.push("B entered"));
      await Promise.resolve();
      cancelB.abort();
      await expect(b).rejects.toThrow(/Stopped/);
      events.push("B cancelled");
      const c = locks.run("term_1", never, async () => void events.push("C entered"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events).toEqual(["A entered", "B cancelled"]);
      releaseA();
      await Promise.all([a, c]);
      expect(events).toEqual(["A entered", "B cancelled", "A left", "C entered"]);
    });

    it("runs one command per tab at a time: a second call waits, then checks the shell again", async () => {
      const terminal = shell({
        respond: integrated({ "sudo -k id": { output: "uid=0(root)\r\n", code: 0, after: 1_000 }, pwd: { output: "/Users/me/app\r\n", code: 0 } }),
      });
      terminal.print(prompt());
      const shared = context();
      const [first, second] = await Promise.all([
        runCommand(terminal.ports, TAB, { command: "sudo -k id" }, shared),
        runCommand(terminal.ports, TAB, { command: "pwd" }, shared),
      ]);
      // Never "pwd" while sudo waits for its password.
      expect(terminal.typed).toEqual(["sudo -k id", "\r", "pwd", "\r"]);
      expect(first).toContain("uid=0(root)");
      expect(second).toContain("/Users/me/app");
    });

    it("refuses the second call when the first one's command is still running", async () => {
      const terminal = shell({ respond: integrated({ "sleep 100": { output: "", code: 0, after: 100_000 } }) });
      terminal.print(prompt());
      const shared = context();
      const results = await Promise.allSettled([
        runCommand(terminal.ports, TAB, { command: "sleep 100", timeoutMs: 2_000 }, shared),
        runCommand(terminal.ports, TAB, { command: "pwd" }, shared),
      ]);
      expect(results[0]).toMatchObject({ status: "fulfilled" });
      expect(results[1]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/still running/) }) });
      expect(terminal.typed).toEqual(["sleep 100", "\r"]);
    });

    it("leaves the line alone and presses no Enter when the user typed at the same moment", async () => {
      // Before the agent's text, and after it: erasing would take the user's "x" with it.
      for (const [before, after] of [
        ["x", ""],
        ["", "x"],
      ]) {
        const terminal = shell({ echo: false });
        terminal.ports.input = ((input) => async (terminalId: string, data: string) => {
          if (data === "pwd") terminal.print(`${before}pwd${after}`);
          await input(terminalId, data);
        })(terminal.ports.input);
        terminal.print(prompt());
        const refusal = runCommand(terminal.ports, TAB, { command: "pwd" }, context());
        await expect(refusal).rejects.toThrow(/did not show exactly that command/);
        await expect(refusal).rejects.toThrow(/nothing was erased either: ask the user to look at the prompt/);
        expect(terminal.typed).toEqual(["pwd"]);
      }
    });

    it("presses no Enter when the user put text after the agent's before the echo came (Ctrl-A after the check)", async () => {
      const terminal = shell({ echo: false });
      terminal.ports.input = ((input) => async (terminalId: string, data: string) => {
        // The user typed "echo OWNER" and went back to its start; zsh inserts the agent's text there.
        if (data === "pwd") terminal.print("echo OWNER\u001b[10Dpwdecho OWNER\u001b[10D");
        await input(terminalId, data);
      })(terminal.ports.input);
      terminal.print(prompt());
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/"pwdecho OWNER"/);
      expect(terminal.typed).toEqual(["pwd"]);
    });

    it("leaves the line alone when the cursor was moved after the agent's text was echoed", async () => {
      const terminal = shell();
      terminal.ports.input = ((input) => async (terminalId: string, data: string) => {
        await input(terminalId, data);
        if (data === "pwd") terminal.print("\u001b[2D");
      })(terminal.ports.input);
      terminal.print(prompt());
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/nothing was erased either/);
      expect(terminal.typed).toEqual(["pwd"]);
    });

    it("runs the command when the line editor suggests a longer one after it (zsh-autosuggestions)", async () => {
      const terminal = shell({ respond: integrated({ pwd: { output: "/Users/me/app\r\n", code: 0 } }) });
      terminal.ports.input = ((input) => async (terminalId: string, data: string) => {
        await input(terminalId, data);
        // The rest of a remembered command, in grey, with the cursor back after the typed text.
        if (data === "pwd") terminal.print("\u001b[90m -P\u001b[39m\u001b[3D");
      })(terminal.ports.input);
      terminal.print(prompt());
      expect(await runCommand(terminal.ports, TAB, { command: "pwd" }, context())).toContain("it succeeded (exit code 0)");
      expect(terminal.typed).toEqual(["pwd", "\r"]);
    });

    it("presses no Enter when text after the agent's is in the same colours as what it typed", async () => {
      const terminal = shell();
      terminal.ports.input = ((input) => async (terminalId: string, data: string) => {
        await input(terminalId, data);
        if (data === "pwd") terminal.print(" OWNER\u001b[6D");
      })(terminal.ports.input);
      terminal.print(prompt());
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/"pwd OWNER"/);
      expect(terminal.typed).toEqual(["pwd"]);
    });

    it("runs a command the line editor escaped as it was typed (oh-my-zsh's url-quote-magic)", async () => {
      const url = "curl -s http://localhost:8080/?a=1&b=2";
      const terminal = shell({ echo: false, respond: integrated({ [url]: { output: "ok\r\n", code: 0 } }) });
      terminal.ports.input = ((input) => async (terminalId: string, data: string) => {
        if (data === url) terminal.print("curl -s http://localhost:8080/\\?a=1\\&b=2");
        await input(terminalId, data);
      })(terminal.ports.input);
      terminal.print(prompt());
      expect(await runCommand(terminal.ports, TAB, { command: url }, context())).toContain("it succeeded (exit code 0)");
      expect(terminal.typed).toEqual([url, "\r"]);
    });

    it("presses no Enter and erases nothing when nothing echoes it (a program reading a password)", async () => {
      const terminal = shell({ echo: false });
      terminal.print(ownerPrompt);
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context())).rejects.toThrow(/did not show exactly that command/);
      expect(terminal.typed).toEqual(["pwd"]);
      expect(terminal.elapsed()).toBeGreaterThanOrEqual(ECHO_TIMEOUT_MS);
    });
  });

  describe("stopping, and a chat that lost the tab", () => {
    it("types nothing when the call was stopped before it began, or while the shell was being read", async () => {
      const before = shell({ respond: integrated({}) });
      before.print(prompt());
      const stopped = new AbortController();
      stopped.abort();
      await expect(runCommand(before.ports, TAB, { command: "pwd" }, context({ signal: stopped.signal }))).rejects.toThrow(/Stopped/);
      expect(before.typed).toEqual([]);

      const during = shell({ respond: integrated({}) });
      during.print(prompt());
      const controller = new AbortController();
      const output = during.ports.output;
      during.ports.output = async (args) => {
        controller.abort();
        return output(args);
      };
      await expect(runCommand(during.ports, TAB, { command: "pwd" }, context({ signal: controller.signal }))).rejects.toThrow(/Stopped/);
      expect(during.typed).toEqual([]);
    });

    it("types nothing once the chat let go of the tab while the shell was being read", async () => {
      const terminal = shell({ respond: integrated({}) });
      terminal.print(prompt());
      let attached = true;
      const output = terminal.ports.output;
      terminal.ports.output = async (args) => {
        attached = false;
        return output(args);
      };
      const checkAccess = () => {
        if (!attached) throw new TerminalToolError("This chat is not connected to a terminal any more.");
      };
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context({ checkAccess }))).rejects.toThrow(/not connected/);
      expect(terminal.typed).toEqual([]);
    });

    it("erases the agent's text, once echoed, when the call is stopped before Enter", async () => {
      const controller = new AbortController();
      const terminal = shell({ respond: integrated({}), onInput: (data) => void (data === "pwd" && controller.abort()) });
      terminal.print(prompt());
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context({ signal: controller.signal }))).rejects.toThrow(
        /Stopped before the command was run\. What was typed was erased\./,
      );
      expect(terminal.typed).toEqual(["pwd", DEL.repeat(3)]);
    });

    it("erases nothing when another writer added to the line while the chat was letting go", async () => {
      let attached = true;
      const terminal = shell({ respond: integrated({}) });
      terminal.ports.input = ((input) => async (terminalId: string, data: string) => {
        await input(terminalId, data);
        if (data === "pwd") attached = false;
      })(terminal.ports.input);
      const checkAccess = () => {
        if (attached) return;
        // The replacement chat (or the user) types before the rollback reads the line.
        terminal.print(" ls");
        throw new TerminalToolError("This chat is not connected to a terminal any more.");
      };
      terminal.print(prompt());
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context({ checkAccess }))).rejects.toThrow(/nothing was erased either/);
      expect(terminal.typed).toEqual(["pwd"]);
    });

    it("erases the typed command and presses no Enter when the chat lets go while it is being echoed", async () => {
      let attached = true;
      const terminal = shell({ respond: integrated({}), onInput: (data) => void (data === "pwd" && (attached = false)) });
      terminal.print(prompt());
      const checkAccess = () => {
        if (!attached) throw new TerminalToolError("This chat is not connected to a terminal any more.");
      };
      await expect(runCommand(terminal.ports, TAB, { command: "pwd" }, context({ checkAccess }))).rejects.toThrow(/not connected/);
      expect(terminal.typed).toEqual(["pwd", DEL.repeat(3)]);
    });

    it("stops waiting when the call is cancelled after the command ran", async () => {
      const terminal = shell({ respond: integrated({ "sleep 100": { output: "", code: 0, after: 100_000 } }) });
      terminal.print(prompt());
      const controller = new AbortController();
      terminal.ports.announce = () => controller.abort();
      await expect(runCommand(terminal.ports, TAB, { command: "sleep 100" }, context({ signal: controller.signal }))).rejects.toThrow(
        /Stopped while waiting for the command/,
      );
      expect(terminal.typed).toEqual(["sleep 100", "\r"]);
    });
  });
});
