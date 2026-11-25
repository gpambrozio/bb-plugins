import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelBbRuns, EXIT_MARKER, exitStatus, plainText, runBbCommand, summarize, TIMEOUT_MARKER, wrap, WRAPPER } from "./bb-command";

const BEL = "\u0007";
const b64 = (text: string) => btoa(text);

function fakeSdk(pages: { text: string; status?: "running" | "exited"; exitCode?: number | null }[], cli = { installedPath: "/usr/local/bin/bb" as string | null, supported: true }) {
  let call = 0;
  const calls: { method: string; args: unknown }[] = [];
  const sdk = {
    system: {
      experimental_cliCommand: async () => ({ ...cli, onPath: true, shadowedBy: null }),
      config: async () => ({ primaryHostId: "host1" }),
    },
    terminals: {
      create: async (args: unknown) => {
        calls.push({ method: "create", args });
        return { id: "term1" };
      },
      output: async (args: unknown) => {
        calls.push({ method: "output", args });
        const page = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return { chunks: page?.text ? [{ seq: call, dataBase64: b64(page.text) }] : [], nextSeq: call + 1, status: page?.status ?? "running", exitCode: page?.exitCode ?? null, closeReason: null, truncated: false };
      },
      close: async (args: unknown) => {
        calls.push({ method: "close", args });
        return {};
      },
    },
  };
  return { sdk: sdk as never, calls };
}

const instant = { sleep: async () => {} };

describe("runBbCommand", () => {
  it("runs bb with the words as they are, in a terminal on the server's machine, and reads the result", async () => {
    const { sdk, calls } = fakeSdk([{ text: "Spoke.\r\n" }, { text: `${EXIT_MARKER}0${BEL}` }]);
    await expect(runBbCommand(sdk, ["herald", "say", "hi there"], instant)).resolves.toEqual({ outcome: "finished", exitCode: 0, output: "Spoke.\n" });
    expect(calls[0]).toEqual({
      method: "create",
      args: expect.objectContaining({
        scope: { kind: "host_path", hostId: "host1", cwd: null },
        start: { mode: "argv", argv: ["/bin/sh", "-c", WRAPPER, "/usr/local/bin/bb", "herald", "say", "hi there"] },
      }),
    });
    // Reads only what is new each time, and closes the terminal at the end.
    expect(calls.filter((call) => call.method === "output").map((call) => call.args)).toEqual([{ terminalId: "term1" }, { terminalId: "term1", sinceSeq: 2 }]);
    expect(calls.at(-1)).toEqual({ method: "close", args: { terminalId: "term1", mode: "force" } });
  });

  it("reports a failing command's exit status", async () => {
    const { sdk } = fakeSdk([{ text: `no such command${EXIT_MARKER}2${BEL}` }]);
    await expect(runBbCommand(sdk, ["nope"], instant)).resolves.toEqual({ outcome: "finished", exitCode: 2, output: "no such command" });
  });

  it("reports a wrapper that ended by itself", async () => {
    const { sdk } = fakeSdk([{ text: "killed", status: "exited", exitCode: 137 }]);
    await expect(runBbCommand(sdk, ["slow"], instant)).resolves.toMatchObject({ outcome: "finished", exitCode: 137 });
  });

  it("gives up a little after the minute when the server never reports, and closes the terminal", async () => {
    const { sdk, calls } = fakeSdk([{ text: "still going" }]);
    let clock = 0;
    const result = await runBbCommand(sdk, ["watch"], { sleep: async () => void (clock += 1000), now: () => clock });
    expect(result).toMatchObject({ outcome: "timed-out" });
    expect(result.outcome === "timed-out" && result.output.startsWith("still goingstill going")).toBe(true);
    expect(calls.at(-1)?.method).toBe("close");
  });

  it("reports the server's watchdog stopping the command as a timeout", async () => {
    const { sdk } = fakeSdk([{ text: `tail of the log\r\n${TIMEOUT_MARKER}${EXIT_MARKER}143${BEL}` }]);
    await expect(runBbCommand(sdk, ["plugin", "logs", "herald", "-f"], instant)).resolves.toEqual({ outcome: "timed-out", output: "tail of the log\n" });
  });

  it("does not wait forever on a read that never answers", async () => {
    const { sdk, calls } = fakeSdk([]);
    let reads = 0;
    (sdk as { terminals: { output: () => Promise<never> } }).terminals.output = () => {
      reads += 1;
      return new Promise(() => {});
    };
    let clock = 0;
    const result = await runBbCommand(sdk, ["x"], { sleep: async (ms) => void (clock += ms), now: () => clock });
    expect(result).toEqual({ outcome: "timed-out", output: "" });
    expect(reads).toBeGreaterThan(1);
    expect(calls.at(-1)).toEqual({ method: "close", args: { terminalId: "term1", mode: "force" } });
  });

  it("stops and closes every run when the page goes away", async () => {
    const { sdk, calls } = fakeSdk([{ text: "following" }]);
    const tick = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))) };
    const runs = [runBbCommand(sdk, ["plugin", "logs", "-f"], tick), runBbCommand(sdk, ["thread", "watch"], tick)];
    await new Promise((resolve) => setTimeout(resolve, 30));
    cancelBbRuns();
    const results = await Promise.all(runs);
    expect(results.map((result) => result.outcome)).toEqual(["cancelled", "cancelled"]);
    expect(calls.filter((call) => call.method === "close")).toHaveLength(2);
  });

  it("runs nothing without bb's command-line tool", async () => {
    const { sdk, calls } = fakeSdk([], { installedPath: null, supported: true });
    await expect(runBbCommand(sdk, ["herald"], instant)).resolves.toMatchObject({ outcome: "unavailable" });
    expect(calls).toEqual([]);
  });

  it("closes the terminal when reading it fails", async () => {
    const { sdk, calls } = fakeSdk([]);
    (sdk as { terminals: { output: () => Promise<never> } }).terminals.output = vi.fn(async () => {
      throw new Error("gone");
    });
    await expect(runBbCommand(sdk, ["x"], instant)).rejects.toThrow("gone");
    expect(calls.at(-1)?.method).toBe("close");
  });
});

describe("output", () => {
  it("finds the exit status only once the marker is complete", () => {
    expect(exitStatus(`x${EXIT_MARKER}0${BEL}`)).toBe(0);
    expect(exitStatus(`x${EXIT_MARKER}12`)).toBeNull();
    expect(exitStatus("x")).toBeNull();
  });

  it("drops colours and keeps what a carriage return drew last", () => {
    expect(plainText("\u001b[32mok\u001b[0m\r\n10%\r50%\r100%\n")).toBe("ok\n100%\n");
  });

  it("keeps the last lines for the notice", () => {
    expect(summarize(Array.from({ length: 10 }, (_, n) => `line ${n}`).join("\n") + "\n\n")).toBe(["line 4", "line 5", "line 6", "line 7", "line 8", "line 9"].join("\n"));
  });
});

// The wrapper itself, run by a real `sh` under a pseudo-terminal as bb's terminal runs it. The command
// (`$0` is `sh` here) starts a child and writes both process ids, so the test can see them stop.
const PTY_RUN = fileURLToPath(new URL("./testing/pty-run.py", import.meta.url));
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const COMMAND = 'sleep 30 & echo $! > "$1"; echo $$ > "$2"; wait';
/** A command whose child ignores TERM, as one shutting down slowly would. */
const STUBBORN = '( trap "" TERM; exec sleep 30 ) & echo $! > "$1"; echo $$ > "$2"; wait';
/** A command that ends at once and leaves such a child behind. */
const LEAVES_CHILD = '( trap "" TERM; exec sleep 30 ) & echo $! > "$1"; echo $$ > "$2"; exit 0';
const started: { pids: () => (number | null)[]; harness: ReturnType<typeof spawn> }[] = [];

/** Every shell `/bin/sh` may be: bash on macOS, dash on Debian and Ubuntu (CI). */
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((shell) => existsSync(shell));

function startWrapper(shell: string, deadlineSeconds: number, command = COMMAND) {
  const dir = mkdtempSync(join(tmpdir(), "duo-rail-wrapper-"));
  const files = { child: join(dir, "child"), self: join(dir, "self") };
  const harness = spawn("python3", [PTY_RUN, shell, "-c", wrap(`"$0" "$@"`, deadlineSeconds), shell, "-c", command, "x", files.child, files.self]);
  let output = "";
  let errors = "";
  harness.stdout.on("data", (data: Buffer) => (output += data.toString()));
  harness.stderr.on("data", (data: Buffer) => (errors += data.toString()));
  const shellPid = () => Number(errors.split("\n")[0]);
  const pidIn = (file: string) => (existsSync(file) && readFileSync(file, "utf8").trim() !== "" ? Number(readFileSync(file, "utf8")) : null);
  started.push({ pids: () => [shellPid(), pidIn(files.child), pidIn(files.self)], harness });
  return { harness, output: () => output, shellPid, child: () => pidIn(files.child), self: () => pidIn(files.self) };
}

const alive = (pid: number | null) => {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return test();
}

describe.skipIf(!hasPython).each(SHELLS)("the wrapper on the server's machine, in %s", (shell) => {
  afterEach(() => {
    // Only what these tests started: the wrapper shell and its harness (closing the harness's terminal
    // hangs up on whatever is left in it).
    for (const { pids, harness } of started.splice(0)) {
      for (const pid of pids()) if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL");
      harness.kill("SIGKILL");
    }
  });

  it("stops the command and its children at the deadline, even with the wrapper and its terminal gone", async () => {
    const run = startWrapper(shell, 1);
    expect(await until(() => alive(run.child()) && alive(run.self()) && alive(run.shellPid()), 5000)).toBe(true);
    const [child, self] = [run.child(), run.self()];
    // The page closed and the terminal with it, the wrapper killed outright: nothing is left to clean up.
    process.kill(run.shellPid(), "SIGKILL");
    run.harness.kill("SIGKILL");
    expect(alive(child)).toBe(true);
    expect(await until(() => !alive(child) && !alive(self), 6000)).toBe(true);
  }, 15_000);

  it("stops the command and its children at once on a hang-up (the terminal closed)", async () => {
    const run = startWrapper(shell, 30);
    expect(await until(() => alive(run.child()) && alive(run.self()) && alive(run.shellPid()), 5000)).toBe(true);
    const [child, self] = [run.child(), run.self()];
    process.kill(run.shellPid(), "SIGHUP");
    expect(await until(() => !alive(child) && !alive(self), 3000)).toBe(true);
  }, 15_000);

  it("with the page gone and the terminal left open, stops the command at the deadline and says so, with no job notices", async () => {
    const run = startWrapper(shell, 1);
    expect(await until(() => run.output().includes(EXIT_MARKER) && run.output().includes("\u0007", run.output().indexOf(EXIT_MARKER)), 8000)).toBe(true);
    expect(run.output()).toContain(TIMEOUT_MARKER);
    expect(exitStatus(run.output())).toBe(143);
    expect(run.output()).not.toMatch(/Terminated|Killed|Done/);
    expect(alive(run.child()) || alive(run.self())).toBe(false);
  }, 15_000);

  it("with the page gone and the wrapper alive, kills a child that ignores TERM at the deadline, and reports the end only once it is gone", async () => {
    const run = startWrapper(shell, 1, STUBBORN);
    expect(await until(() => alive(run.child()) && alive(run.self()), 5000)).toBe(true);
    const child = run.child();
    // Nobody reads or closes the terminal; the wrapper runs on.
    expect(await until(() => exitStatus(run.output()) !== null, 12_000)).toBe(true);
    expect(run.output()).toContain(TIMEOUT_MARKER);
    // Reported only after the cleanup: the child is already gone (allowing its reaping by init).
    expect(await until(() => !alive(child), 500)).toBe(true);
    expect(alive(run.shellPid())).toBe(true);
  }, 20_000);

  it("kills a child that ignores TERM even when the wrapper itself was killed outright", async () => {
    const run = startWrapper(shell, 1, STUBBORN);
    expect(await until(() => alive(run.child()) && alive(run.self()) && alive(run.shellPid()), 5000)).toBe(true);
    const child = run.child();
    process.kill(run.shellPid(), "SIGKILL");
    run.harness.kill("SIGKILL");
    expect(await until(() => !alive(child), 10_000)).toBe(true);
  }, 20_000);

  it("kills what a command that ended left in its group before reporting its status", async () => {
    const run = startWrapper(shell, 30, LEAVES_CHILD);
    expect(await until(() => alive(run.child()), 5000)).toBe(true);
    const child = run.child();
    expect(await until(() => exitStatus(run.output()) !== null, 10_000)).toBe(true);
    expect(exitStatus(run.output())).toBe(0);
    expect(run.output()).not.toContain(TIMEOUT_MARKER);
    expect(await until(() => !alive(child), 500)).toBe(true);
  }, 20_000);

  it("reports a command that ends in time, and its watchdog is gone with it", async () => {
    const run = startWrapper(shell, 1, "echo finished; echo complaint >&2; exit 3");
    expect(await until(() => exitStatus(run.output()) !== null, 5000)).toBe(true);
    expect(exitStatus(run.output())).toBe(3);
    expect(plainText(run.output())).toContain("finished");
    // The command's own errors still show.
    expect(plainText(run.output())).toContain("complaint");
    // Past the deadline, the watchdog has not fired.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(run.output()).not.toContain(TIMEOUT_MARKER);
  }, 15_000);
});
