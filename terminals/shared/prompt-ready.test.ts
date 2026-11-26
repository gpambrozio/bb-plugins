/**
 * When a terminal shows its shell waiting at an empty prompt, read by a real
 * xterm.js parser (`@xterm/headless`) from what shells print.
 */
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_PROMPT_ROWS, promptReadiness } from "./prompt-ready";
import { ShellTracker } from "./shell-marks";

const osc = (body: string) => `\u001b]${body}\u0007`;
const report = osc("7;file://mac/Users/me/app");

const terminals: Terminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

async function readiness(output: string, cols = 60) {
  const terminal = new Terminal({ cols, rows: 24, scrollback: 1000, allowProposedApi: true });
  terminals.push(terminal);
  const tracker = new ShellTracker(terminal);
  await new Promise<void>((resolve) => terminal.write(output, resolve));
  return promptReadiness(terminal, tracker);
}

describe("promptReadiness without marks", () => {
  it("takes a prompt drawn after a directory report, ending in a prompt sign and a space", async () => {
    for (const prompt of ["me@mac app % ", "[me@mac app]$ ", "root@mac:/# ", "app ❯ ", "\r\n╭─me@mac ~/app ‹main›\r\n╰─$ "]) {
      expect(await readiness(report + prompt), prompt).toMatchObject({ ready: true });
    }
  });

  it("leaves a right-hand prompt at the line's edge out of what is typed", async () => {
    expect(await readiness(`${report}me@mac app % \u001b7\u001b[57G1 ↵\u001b8`)).toMatchObject({ ready: true });
  });

  it("refuses a prompt of another shape, one taller than the limit, or one with something after the cursor", async () => {
    // oh-my-zsh's robbyrussell theme ends in the directory's name.
    expect(await readiness(`${report}➜  app `)).toEqual({ ready: false, reason: "no-prompt" });
    expect(await readiness(report + "info\r\n".repeat(MAX_PROMPT_ROWS) + "$ ")).toEqual({ ready: false, reason: "no-prompt" });
    expect(await readiness(`${report}me@mac app % \r\nzsh: do you wish to see all 200 possibilities?`)).toEqual({ ready: false, reason: "no-prompt" });
    expect(await readiness(`${report}me@mac app % ls -la\u001b[6D`)).toEqual({ ready: false, reason: "typed", typed: "ls -la" });
  });

  it("refuses a second prompt sign after the shell's own: a program's prompt, or text typed ahead", async () => {
    expect(await readiness(`${report}me@mac app % python3 -q\r\n>>> `)).toEqual({ ready: false, reason: "no-prompt" });
    expect(await readiness(`${report}➜  app irb\r\nirb(main):001> `)).toEqual({ ready: false, reason: "no-prompt" });
    expect(await readiness(`${report}me@mac app % echo # `)).toEqual({ ready: false, reason: "no-prompt" });
  });
});

describe("promptReadiness with marks", () => {
  it("takes an empty marked prompt, whatever its shape, and refuses one with typing on either side of the cursor", async () => {
    const prompt = `${osc("133;A")}➜  app ${osc("133;B")}`;
    expect(await readiness(prompt)).toMatchObject({ ready: true });
    expect(await readiness(`${prompt}git sta`)).toEqual({ ready: false, reason: "typed", typed: "git sta" });
    expect(await readiness(`${prompt}git status\u001b[3D`)).toEqual({ ready: false, reason: "typed", typed: "git status" });
  });

  it("refuses while a command runs, and in a full-screen program", async () => {
    const prompt = `${osc("133;A")}% ${osc("133;B")}`;
    expect(await readiness(`${prompt}make\r\n${osc("133;C")}`)).toEqual({ ready: false, reason: "running" });
    expect(await readiness(`${prompt}vim\r\n${osc("133;C")}\u001b[?1049h`)).toEqual({ ready: false, reason: "full-screen" });
  });
});
