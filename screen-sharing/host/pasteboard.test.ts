/**
 * A Mac's clipboard as the plugin reads it, over an in-memory pasteboard: the
 * change count always, the text only when asked for and changed, with the
 * count it was read at, never more than the clipboard syncs, and the account
 * it belongs to. And the command runner every pasteboard command goes
 * through, against Node children (never a pasteboard command): it settles
 * once on every way a child can fail, with no uncaught stream error.
 */
import { describe, expect, it } from "vitest";

import { MAX_CLIPBOARD_BYTES } from "../shared/channels";
import { FakePasteboardCommands } from "../testing/fake-pasteboard";
import { Pasteboard, runCommand } from "./pasteboard";

const account = { userName: "ci", fullName: "CI Bot" };

describe("a Mac's clipboard", () => {
  it("answers the change count, and the text only when asked for and changed", async () => {
    const commands = new FakePasteboardCommands();
    commands.copy("naïve “quotes” € 日本語 🙂");
    const pasteboard = new Pasteboard(commands);
    expect(await pasteboard.read(null)).toEqual({ account, changeCount: 2, text: null, tooLarge: false });
    expect(await pasteboard.read(2)).toEqual({ account, changeCount: 2, text: null, tooLarge: false });
    expect(await pasteboard.read(1)).toEqual({ account, changeCount: 2, text: "naïve “quotes” € 日本語 🙂", tooLarge: false });
  });

  it("writes text and answers with the count the write moved it to", async () => {
    const commands = new FakePasteboardCommands();
    const pasteboard = new Pasteboard(commands);
    expect(await pasteboard.write("🙂")).toEqual({ account, changeCount: 2 });
    expect(commands.text).toBe("🙂");
  });

  it("sends no text longer than the clipboard syncs, only that it is", async () => {
    const commands = new FakePasteboardCommands();
    commands.copy("é".repeat(MAX_CLIPBOARD_BYTES / 2 + 1));
    const pasteboard = new Pasteboard(commands);
    expect(await pasteboard.read(-1)).toMatchObject({ text: null, tooLarge: true });
    await expect(pasteboard.write("x".repeat(MAX_CLIPBOARD_BYTES + 1))).rejects.toThrow("longer than the clipboard syncs");
  });

  it("asks macOS for the account's full name once", async () => {
    const commands = new FakePasteboardCommands("gustavo", null);
    const pasteboard = new Pasteboard(commands);
    await pasteboard.read(null);
    await pasteboard.read(null);
    expect((await pasteboard.read(null)).account).toEqual({ userName: "gustavo", fullName: null });
    expect(commands.fullNameCalls).toBe(1);
  });

  it("refuses on a machine that is not a Mac", async () => {
    const commands = new FakePasteboardCommands();
    commands.platform = "linux";
    await expect(new Pasteboard(commands).read(null)).rejects.toThrow("not a Mac");
  });

  it("answers a write with the count of that write, so a copy right after it is seen", async () => {
    const commands = new FakePasteboardCommands();
    const pasteboard = new Pasteboard(commands);
    const { changeCount } = await pasteboard.write("B");
    commands.copy("C");
    expect(await pasteboard.read(changeCount)).toMatchObject({ changeCount: changeCount + 1, text: "C" });
  });

  it("pairs the text with the count it was read at, when a copy lands between the two", async () => {
    const commands = new FakePasteboardCommands();
    commands.copy("A");
    const pasteboard = new Pasteboard(commands);
    // The count is sampled at A; the text read after it is C's, and comes with C's count.
    commands.beforeChangeCount = () => {
      commands.beforeChangeCount = null;
      queueMicrotask(() => commands.copy("C"));
    };
    const read = await pasteboard.read(1);
    expect(read).toMatchObject({ text: "C", changeCount: 3 });
  });

  it("reads literal RTF and EPS source as the text it is, and a picture as no text", async () => {
    const commands = new FakePasteboardCommands();
    const pasteboard = new Pasteboard(commands);
    for (const literal of ["{\\rtf1\\ansi hello}", "%!PS-Adobe-3.0 EPSF-3.0"]) {
      const { changeCount } = await pasteboard.write(literal);
      expect(await pasteboard.read(changeCount - 1)).toMatchObject({ text: literal });
    }
    commands.copyPicture();
    expect(await pasteboard.read(-1)).toMatchObject({ text: null, tooLarge: false });
  });
});

describe("the command runner", () => {
  const node = process.execPath;
  const options = { timeoutMs: 5_000, maxOutputBytes: 1024 * 1024, env: process.env };

  it("gives a command's output, and its input as written", async () => {
    const echoed = await runCommand(node, ["-e", "process.stdin.pipe(process.stdout)"], { ...options, input: "naïve 🙂" });
    expect(echoed.toString("utf8")).toBe("naïve 🙂");
  });

  it("fails, with no uncaught error, when the command exits before reading its input", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      await expect(runCommand(node, ["-e", "process.exit(3)"], { ...options, input: "x".repeat(4 * 1024 * 1024) })).rejects.toThrow(
        /node (failed \(3\)|did not take its input)/,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it("fails when the executable is missing", async () => {
    await expect(runCommand("/nonexistent/pbsomething", [], options)).rejects.toThrow(/ENOENT/);
  });

  it("kills a command that does not finish in time", async () => {
    const started = Date.now();
    await expect(runCommand(node, ["-e", "setTimeout(() => {}, 60000)"], { ...options, timeoutMs: 200 })).rejects.toThrow(
      "node did not finish within 200 ms",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("kills a command whose output passes its limit", async () => {
    await expect(runCommand(node, ["-e", "process.stdout.write('x'.repeat(5000))"], { ...options, maxOutputBytes: 100 })).rejects.toThrow(
      "node wrote more than 100 bytes",
    );
  });

  it("says why a command failed", async () => {
    await expect(runCommand(node, ["-e", "console.error('no pasteboard'); process.exit(1)"], options)).rejects.toThrow(
      "node failed (1): no pasteboard",
    );
  });
});
