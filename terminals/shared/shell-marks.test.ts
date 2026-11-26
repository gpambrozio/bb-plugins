/**
 * Shell-integration marks, read by a real xterm.js parser (`@xterm/headless`,
 * the same engine the page draws with), as a shell with an OSC 133 prompt
 * prints them.
 */
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";

import { lastLines, parseShellMark, ShellTracker, type FinishedCommand } from "./shell-marks";

const ESC = "\u001b";
const BEL = "\u0007";
const osc = (body: string) => `${ESC}]${body}${BEL}`;
/** A prompt as an integrated zsh draws it: A, the prompt, B. */
const prompt = (text = "~ % ") => `${osc("133;A")}${text}${osc("133;B")}`;
/** The user typed `command` and pressed Enter; the shell echoes it and marks the start of its output. */
const run = (command: string) => `${command}\r\n${osc("133;C")}`;
const done = (code: number) => osc(`133;D;${code}`);

const terminals: Terminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

function setUp(cols = 80) {
  const terminal = new Terminal({ cols, rows: 24, scrollback: 1000, allowProposedApi: true });
  terminals.push(terminal);
  const tracker = new ShellTracker(terminal);
  const finished: FinishedCommand[] = [];
  tracker.onFinished((command) => finished.push(command));
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  return { terminal, tracker, finished, write };
}

describe("parseShellMark", () => {
  it("reads OSC 133's prompt and command marks", () => {
    expect(parseShellMark(133, "A")).toEqual({ kind: "prompt-start" });
    expect(parseShellMark(133, "A;aid=12")).toEqual({ kind: "prompt-start" });
    expect(parseShellMark(133, "B")).toEqual({ kind: "prompt-end" });
    expect(parseShellMark(133, "C")).toEqual({ kind: "command-start" });
    expect(parseShellMark(133, "D;127")).toEqual({ kind: "command-end", exitCode: 127 });
    expect(parseShellMark(133, "D")).toEqual({ kind: "command-end", exitCode: null });
    expect(parseShellMark(133, "D;aid=12")).toEqual({ kind: "command-end", exitCode: null });
    expect(parseShellMark(133, "P;k=i")).toBeNull();
  });

  it("reads VS Code's command line, unescaped", () => {
    expect(parseShellMark(633, "E;echo a\\x3bb \\\\ c;nonce")).toEqual({ kind: "command-line", commandLine: "echo a;b \\ c" });
    expect(parseShellMark(133, "E;ls")).toBeNull();
  });
});

describe("ShellTracker", () => {
  it("reports a failed command with its line, output and exit status", async () => {
    const { tracker, finished, write } = setUp();
    await write(osc("7;file://mini/Users/me/app"));
    await write(prompt());
    expect(tracker.phase()).toBe("prompt");
    await write(run("npm test"));
    expect(tracker.phase()).toBe("running");
    await write("> app@1.0.0 test\r\nError: 2 tests failed\r\n");
    await write(done(1));
    await write(prompt());
    expect(finished).toEqual([
      { command: "npm test", output: "> app@1.0.0 test\nError: 2 tests failed", truncated: false, exitCode: 1, cwd: "/Users/me/app" },
    ]);
    expect(tracker.last()?.exitCode).toBe(1);
    expect(tracker.hasIntegration()).toBe(true);
  });

  it("reads the output as drawn, after progress redraws", async () => {
    const { finished, write } = setUp();
    await write(prompt() + run("fetch"));
    await write("10%\r50%\r100%\r\nfailed: timeout\r\n" + done(2));
    expect(finished[0]?.output).toBe("100%\nfailed: timeout");
  });

  it("joins lines the terminal wrapped", async () => {
    const { finished, write } = setUp(10);
    await write(prompt("$ ") + run("x"));
    await write("abcdefghijKLMNO\r\n" + done(1));
    expect(finished[0]?.output).toBe("abcdefghijKLMNO");
  });

  it("leaves a right-hand prompt out of the command line and of what is typed", async () => {
    const { terminal, tracker, finished, write } = setUp(40);
    // zsh draws RPROMPT at the right edge, then puts the cursor back after the left prompt.
    const rprompt = (text: string) => `\u001b7\u001b[${40 - text.length + 1}G${text}\u001b8`;
    await write(prompt() + rprompt("1 ↵"));
    expect(tracker.pendingInput()).toBe("");
    await write("ls nope");
    expect(tracker.pendingInput()).toBe("ls nope");
    await write(run(""));
    await write("ls: nope: No such file or directory\r\n" + done(1));
    expect(finished[0]?.command).toBe("ls nope");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain("1 ↵");
  });

  it("ignores an end mark with no command (Enter on an empty prompt)", async () => {
    const { tracker, finished, write } = setUp();
    await write(prompt() + "\r\n" + done(0) + prompt());
    expect(finished).toEqual([]);
    expect(tracker.phase()).toBe("prompt");
  });

  it("prefers VS Code's command line to the drawn one", async () => {
    const { finished, write } = setUp();
    await write(prompt() + osc("633;E;make all") + run("make all"));
    await write(done(2));
    expect(finished[0]?.command).toBe("make all");
  });

  it("says what is typed at the prompt and not yet run", async () => {
    const { tracker, write } = setUp();
    expect(tracker.pendingInput()).toBeNull();
    await write(prompt());
    expect(tracker.pendingInput()).toBe("");
    await write("git sta");
    expect(tracker.pendingInput()).toBe("git sta");
    await write(run(""));
    expect(tracker.pendingInput()).toBeNull();
  });

  it("reads what the README's bash lines send, an empty line and another PROMPT_COMMAND included", async () => {
    const { finished, write } = setUp();
    // Recorded from macOS's bash 3.2 with the README's lines and PROMPT_COMMAND='echo -n [pc]'.
    const bashPrompt = `[pc]${osc("133;A")}${osc("7;file://mini/tmp")}b$ ${osc("133;B")}`;
    await write(bashPrompt + "ls nope\r\n" + osc("133;C") + "ls: nope: No such file or directory\r\n" + osc("133;D;1"));
    await write(bashPrompt + "\r\n" + bashPrompt + "echo ok\r\n" + osc("133;C") + "ok\r\n" + osc("133;D;0") + bashPrompt);
    expect(finished.map(({ command, exitCode, cwd }) => ({ command, exitCode, cwd }))).toEqual([
      { command: "ls nope", exitCode: 1, cwd: "/tmp" },
      { command: "echo ok", exitCode: 0, cwd: "/tmp" },
    ]);
  });

  it("stops saying a command runs when a shell without marks draws its prompt (an ssh session that sent them ended)", async () => {
    const { tracker, finished, write } = setUp();
    // The local zsh reports only its directory; over ssh, the remote shell sends marks.
    const local = `${osc("7;file://mac/Users/me/app")}╭─me@mac ~/app\r\n╰─$ `;
    await write(local + "ssh nas\r\n");
    await write(`${osc("133;A")}nas % ${osc("133;B")}` + run("df -h") + "Filesystem  Size\r\n" + done(0));
    await write(`${osc("133;A")}nas % ${osc("133;B")}` + run("exit"));
    expect(tracker.phase()).toBe("running");
    // The connection closes before the remote shell sends `D`; the local prompt comes back.
    await write("Connection to nas closed.\r\n" + local);
    expect(tracker.phase()).toBe("unknown");
    expect(tracker.hasIntegration()).toBe(false);
    expect(tracker.stoppedMarks()).toBe(true);
    expect(tracker.pendingInput()).toBeNull();
    expect(finished.map((command) => command.command)).toEqual(["df -h"]);

    // Marks again (another ssh session, or integration loaded): they count again.
    await write(`${osc("133;A")}nas % ${osc("133;B")}`);
    expect(tracker.hasIntegration()).toBe(true);
    expect(tracker.stoppedMarks()).toBe(false);
    expect(tracker.phase()).toBe("prompt");
  });

  it("still finishes a command when the shell reports its directory before the end mark", async () => {
    const { tracker, finished, write } = setUp();
    await write(prompt() + run("make") + "make: *** [all] Error 2\r\n");
    await write(osc("7;file://mac/Users/me/app") + done(2) + prompt());
    expect(finished.map(({ command, exitCode }) => ({ command, exitCode }))).toEqual([{ command: "make", exitCode: 2 }]);
    expect(tracker.hasIntegration()).toBe(true);
    expect(tracker.phase()).toBe("prompt");
  });

  it("knows nothing of a shell that sends no marks", async () => {
    const { tracker, finished, write } = setUp();
    await write("me@mini ~ % ls nope\r\nls: nope: No such file or directory\r\nme@mini ~ % ");
    expect(tracker.hasIntegration()).toBe(false);
    expect(tracker.phase()).toBe("unknown");
    expect(finished).toEqual([]);
  });

  it("sees a full-screen program", async () => {
    const { tracker, write } = setUp();
    await write(`${ESC}[?1049h`);
    expect(tracker.fullScreen()).toBe(true);
    await write(`${ESC}[?1049l`);
    expect(tracker.fullScreen()).toBe(false);
  });

  it("keeps the last lines of a long output", async () => {
    const { finished, write } = setUp();
    await write(prompt() + run("seq 1000"));
    await write(Array.from({ length: 1000 }, (_, index) => `${index + 1}`).join("\r\n") + "\r\n" + done(1));
    const output = finished[0]!.output.split("\n");
    expect(output).toHaveLength(400);
    expect(output.at(-1)).toBe("1000");
    expect(finished[0]?.truncated).toBe(true);
  });

  it("reads the last lines of the whole buffer", async () => {
    const { terminal, write } = setUp();
    await write("one\r\ntwo\r\nthree\r\n");
    expect(lastLines(terminal, 2)).toEqual({ text: "two\nthree", truncated: true });
    expect(lastLines(terminal, 10)).toEqual({ text: "one\ntwo\nthree", truncated: false });
  });
});
