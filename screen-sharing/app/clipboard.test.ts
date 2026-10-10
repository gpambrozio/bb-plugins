// @vitest-environment jsdom
/**
 * One session's clipboard sync against a fake clipboard here and a fake Mac:
 * Send, Receive, Auto sync both ways with nothing echoed back, the sign-in
 * that is not the account bb runs as, and the remembered Auto sync choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipboardAccount, ClipboardRead } from "../shared/channels";
import {
  ClipboardSync,
  clipboardPreference,
  signedInAsAccount,
  type ClipboardNotice,
  type ClipboardAccess,
  type LocalClipboard,
  type MacClipboard,
} from "./clipboard";

class FakeClipboard implements LocalClipboard {
  text = "";
  reads = 0;
  readError: Error | null = null;
  writable = true;
  writes: string[] = [];

  async readText(): Promise<string> {
    this.reads++;
    if (this.readError !== null) throw this.readError;
    return this.text;
  }

  async writeText(text: string): Promise<boolean> {
    if (!this.writable) return false;
    this.writes.push(text);
    this.text = text;
    return true;
  }
}

/** A Mac's pasteboard as host/pasteboard.ts answers for it. */
class FakeMac implements MacClipboard {
  account: ClipboardAccount = { userName: "ci", fullName: "CI Bot" };
  changeCount = 10;
  text = "";
  reads: Array<number | null> = [];
  writes: string[] = [];
  error: Error | null = null;

  async read(since: number | null): Promise<ClipboardRead> {
    this.reads.push(since);
    if (this.error !== null) throw this.error;
    const text = since === null || since === this.changeCount ? null : this.text;
    return { account: this.account, changeCount: this.changeCount, text, tooLarge: false };
  }

  async write(text: string) {
    if (this.error !== null) throw this.error;
    this.writes.push(text);
    this.text = text;
    this.changeCount++;
    return { account: this.account, changeCount: this.changeCount };
  }

  /** Someone copies on the Mac. */
  copy(text: string): void {
    this.text = text;
    this.changeCount++;
  }
}

let clipboard: FakeClipboard;
let mac: FakeMac;
let notices: ClipboardNotice[];
let accesses: ClipboardAccess[];
let canSync: boolean;
let signedInAs: string | null;
let syncs: ClipboardSync[];

function makeSync(): ClipboardSync {
  const sync = new ClipboardSync(
    { canSync: () => canSync, hostName: () => "MacMini", signedInAs: () => signedInAs },
    mac,
    (notice) => notices.push(notice),
    (access) => accesses.push(access),
    clipboard,
  );
  syncs.push(sync);
  return sync;
}

beforeEach(() => {
  clipboard = new FakeClipboard();
  mac = new FakeMac();
  notices = [];
  accesses = [];
  canSync = true;
  signedInAs = "ci";
  syncs = [];
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  for (const sync of syncs) sync.end();
  vi.restoreAllMocks();
  vi.useRealTimers();
  clipboardPreference.reset();
});

/** Moves past the gap between automatic reads of this computer's clipboard. */
function later(): void {
  vi.setSystemTime(Date.now() + 1_000);
}

describe("Send and Receive", () => {
  it("sends this computer's clipboard to the Mac, any characters, and says so", async () => {
    clipboard.text = "naïve “quotes” € 日本語 🙂";
    await makeSync().send();
    expect(mac.writes).toEqual(["naïve “quotes” € 日本語 🙂"]);
    expect(notices).toEqual([{ tone: "info", text: "Sent this computer’s clipboard to MacMini." }]);
  });

  it("copies the Mac's clipboard here, read fresh", async () => {
    mac.copy("from the Mac 🙂");
    const sync = makeSync();
    await sync.receive();
    expect(clipboard.writes).toEqual(["from the Mac 🙂"]);
    expect(notices.at(-1)).toEqual({ tone: "info", text: "Copied MacMini’s clipboard to this computer." });
    mac.copy("");
    await sync.receive();
    expect(notices.at(-1)).toEqual({ tone: "info", text: "MacMini’s clipboard holds no text." });
  });

  it("offers a Copy button when this browser writes only on a click of its own", async () => {
    mac.copy("needs a click");
    const sync = makeSync();
    clipboard.writable = false;
    await sync.receive();
    expect(notices.at(-1)).toEqual({ tone: "warning", text: "This browser needs one more click to copy MacMini’s clipboard here.", copy: "needs a click" });
    clipboard.writable = true;
    await sync.copyFromNotice("needs a click");
    expect(clipboard.writes).toEqual(["needs a click"]);
  });

  it("says why it sent nothing", async () => {
    const sync = makeSync();
    await sync.send();
    expect(notices.at(-1)).toEqual({ tone: "info", text: "This computer’s clipboard holds no text." });
    clipboard.readError = new DOMException("Read permission denied.", "NotAllowedError");
    await sync.send();
    expect(notices.at(-1)).toEqual({ tone: "warning", text: "bb could not read this computer’s clipboard: Read permission denied." });
    clipboard.readError = null;
    clipboard.text = "x";
    mac.error = new Error("MacMini is offline");
    await sync.send();
    expect(notices.at(-1)).toEqual({ tone: "warning", text: "Could not put the text on MacMini’s clipboard: MacMini is offline." });
  });

  it("says nothing of a Mac it could not reach until asked, then tries again", async () => {
    mac.error = new Error("old bb on that Mac");
    const sync = makeSync();
    await sync.start();
    expect(notices).toEqual([]);
    expect(accesses).toEqual([{ available: false, reason: "Could not reach MacMini’s clipboard: old bb on that Mac." }]);
    await sync.receive();
    expect(notices).toEqual([{ tone: "warning", text: "Could not reach MacMini’s clipboard: old bb on that Mac." }]);
    mac.error = null;
    mac.copy("reachable now");
    await sync.receive();
    expect(clipboard.writes).toEqual(["reachable now"]);
    expect(mac.reads).toEqual([null, null, null, -1]);
  });

  it("says nothing once the session is over", async () => {
    const sync = makeSync();
    sync.end();
    clipboard.text = "late";
    await sync.send();
    await sync.receive();
    expect(mac.writes).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe("the account", () => {
  it("is the one bb runs as on the Mac, by short or full name", () => {
    const account = { userName: "ci", fullName: "CI Bot" };
    expect(signedInAsAccount(" CI ", account)).toBe(true);
    expect(signedInAsAccount("ci bot", account)).toBe(true);
    expect(signedInAsAccount("gustavo", account)).toBe(false);
  });

  it("keeps the sync off, saying why, when the sign-in was another account", async () => {
    signedInAs = "gustavo";
    clipboardPreference.setAutoSync(true);
    const sync = makeSync();
    await sync.start();
    expect(accesses).toEqual([
      { available: false, reason: "Clipboard sync reaches only the clipboard of ci, the account bb runs as on MacMini. Sign in as ci to use it." },
    ]);
    clipboard.text = "secret of another desktop";
    await sync.send();
    await sync.receive();
    mac.copy("ci's clipboard");
    await sync.pollMac();
    expect(mac.writes).toEqual([]);
    expect(clipboard.writes).toEqual([]);
    expect(notices.at(-1)?.text).toBe("Clipboard sync reaches only the clipboard of ci, the account bb runs as on MacMini. Sign in as ci to use it.");
  });

  it("makes no claim when the sign-in named no account", async () => {
    signedInAs = null;
    await makeSync().start();
    expect(accesses).toEqual([{ available: true, account: mac.account }]);
  });
});

describe("Auto sync", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clipboardPreference.setAutoSync(true);
  });

  it("sends this computer's clipboard when it changes, and only then", async () => {
    const sync = makeSync();
    clipboard.text = "one";
    await sync.check();
    expect(mac.writes).toEqual(["one"]);
    later();
    await sync.check();
    expect(mac.writes).toEqual(["one"]);
    later();
    clipboard.text = "two";
    await sync.check();
    expect(mac.writes).toEqual(["one", "two"]);
    // Sent on its own, it says nothing.
    expect(notices).toEqual([]);
  });

  it("copies the Mac's clipboard here when its count moves, reading the text only then", async () => {
    const sync = makeSync();
    await sync.start();
    await sync.pollMac();
    expect(clipboard.writes).toEqual([]);
    mac.copy("copied on the Mac");
    await sync.pollMac();
    expect(clipboard.writes).toEqual(["copied on the Mac"]);
    expect(mac.reads).toEqual([null, 10, 10]);
    // And it is never sent back.
    later();
    await sync.check();
    expect(mac.writes).toEqual([]);
  });

  it("does not copy back what it just sent when the Mac's count moves for it", async () => {
    const sync = makeSync();
    await sync.start();
    clipboard.text = "sent";
    await sync.check();
    await sync.pollMac();
    expect(clipboard.writes).toEqual([]);
  });

  it("leaves a copied picture alone: no text, nothing copied", async () => {
    const sync = makeSync();
    await sync.start();
    clipboard.text = "kept";
    mac.copy("");
    await sync.pollMac();
    expect(clipboard.writes).toEqual([]);
  });

  it("does not send the old text back over the Mac's when copying it here failed", async () => {
    const sync = makeSync();
    await sync.start();
    clipboard.text = "old";
    await sync.check();
    clipboard.writable = false;
    mac.copy("new on the Mac");
    await sync.pollMac();
    expect(notices.at(-1)).toEqual({ tone: "warning", text: "Could not copy MacMini’s clipboard here on its own. Use Receive clipboard." });
    later();
    await sync.check();
    expect(mac.writes).toEqual(["old"]);
  });

  it("watches the Mac only while the screen takes input", async () => {
    const sync = makeSync();
    await sync.start();
    canSync = false;
    mac.copy("unseen");
    await sync.pollMac();
    expect(mac.reads).toEqual([null]);
  });

  it("reads this computer's clipboard only while the window has focus, and not twice at once or in quick succession", async () => {
    const sync = makeSync();
    clipboard.text = "x";
    canSync = false;
    await sync.check();
    canSync = true;
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await sync.check();
    expect(clipboard.reads).toBe(0);

    vi.mocked(document.hasFocus).mockReturnValue(true);
    await Promise.all([sync.check(), sync.check()]);
    expect(clipboard.reads).toBe(1);
    await sync.check();
    expect(clipboard.reads).toBe(1);
    later();
    await sync.check();
    expect(clipboard.reads).toBe(2);
  });

  it("stops reading after the browser refuses, says so once, and tries again when asked", async () => {
    const sync = makeSync();
    clipboard.readError = new DOMException("Read permission denied.", "NotAllowedError");
    await sync.check();
    later();
    await sync.check();
    expect(clipboard.reads).toBe(1);
    expect(notices).toEqual([
      {
        tone: "warning",
        text: "Auto sync can’t read this computer’s clipboard here (Read permission denied), so it won’t send it on its own. Use Send clipboard.",
      },
    ]);

    clipboard.readError = null;
    clipboard.text = "allowed now";
    await sync.check({ asked: true });
    expect(mac.writes).toEqual(["allowed now"]);
  });

  it("does nothing on its own while off", async () => {
    clipboardPreference.setAutoSync(false);
    const sync = makeSync();
    await sync.start();
    clipboard.text = "x";
    mac.copy("y");
    await sync.check();
    await sync.pollMac();
    expect(clipboard.reads).toBe(0);
    expect(clipboard.writes).toEqual([]);
    expect(mac.reads).toEqual([null]);
  });
});

describe("the remembered choice", () => {
  it("is kept on this computer for the next session and the next load", () => {
    expect(clipboardPreference.getAutoSync()).toBe(false);
    const listener = vi.fn();
    const unsubscribe = clipboardPreference.subscribe(listener);
    clipboardPreference.setAutoSync(true);
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("screen-sharing:clipboard-auto-sync")).toBe("on");
    clipboardPreference.setAutoSync(false);
    expect(localStorage.getItem("screen-sharing:clipboard-auto-sync")).toBeNull();
  });
});
