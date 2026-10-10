/**
 * A Mac's clipboard as the plugin reads it, over an in-memory pasteboard: the
 * change count always, the text only when asked for and changed, never more
 * than the clipboard syncs, and the account it belongs to.
 */
import { describe, expect, it } from "vitest";

import { MAX_CLIPBOARD_BYTES } from "../shared/channels";
import { FakePasteboardCommands } from "../testing/fake-pasteboard";
import { Pasteboard } from "./pasteboard";

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
});
