import { describe, expect, it, vi } from "vitest";

import { EXIT_MARKER, exitStatus, plainText, runBbCommand, summarize, TIMEOUT_MS, WRAPPER } from "./bb-command";

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

  it("gives up after a minute and closes the terminal", async () => {
    const { sdk, calls } = fakeSdk([{ text: "still going" }]);
    let clock = 0;
    const result = await runBbCommand(sdk, ["watch"], { sleep: async () => void (clock += 1000), now: () => clock });
    expect(result).toEqual({ outcome: "timed-out", output: "still going".repeat(TIMEOUT_MS / 1000 + 1) });
    expect(calls.at(-1)?.method).toBe("close");
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
