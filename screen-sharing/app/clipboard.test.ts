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
  attemptedWrites: string[] = [];
  /** While set, every call waits for it before answering: a slow link. */
  gate: Promise<void> | null = null;

  /** While true, each call waits for its own release, in `held`, before answering. */
  holdEach = false;
  held: Array<() => void> = [];

  private async hold(): Promise<void> {
    if (this.gate !== null) await this.gate;
    if (this.holdEach) await new Promise<void>((release) => this.held.push(release));
  }

  async read(since: number | null): Promise<ClipboardRead> {
    this.reads.push(since);
    await this.hold();
    if (this.error !== null) throw this.error;
    const text = since === null || since === this.changeCount ? null : this.text;
    return { account: this.account, changeCount: this.changeCount, text, tooLarge: false };
  }

  async write(text: string) {
    this.attemptedWrites.push(text);
    await this.hold();
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

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** Lets every queued step and answer run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
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
    expect(notices.at(-1)).toEqual({ tone: "warning", text: "Could not reach MacMini’s clipboard: MacMini is offline." });
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

describe("one step at a time (review pass 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clipboardPreference.setAutoSync(true);
  });

  it("lets no Mac read land between a send and its answer: the Mac's copy made meanwhile still comes here", async () => {
    const sync = makeSync();
    await sync.start();
    const link = deferred();
    mac.gate = link.promise;
    clipboard.text = "B";
    const sending = sync.check();
    await settle();
    expect(mac.attemptedWrites).toEqual(["B"]);
    // A poll asked for while B is on its way waits for it.
    const polling = sync.pollMac();
    await settle();
    expect(mac.reads).toEqual([null]);
    // Someone copies A on the Mac after B landed there.
    link.resolve();
    mac.gate = null;
    await sending;
    mac.copy("A");
    await polling;
    await sync.pollMac();
    expect(clipboard.text).toBe("A");
    expect(mac.text).toBe("A");
  });

  it("answers Send, Receive and polls in the order asked, so an older poll never overwrites a newer Receive", async () => {
    const sync = makeSync();
    await sync.start();
    mac.holdEach = true;
    mac.copy("older");
    const polling = sync.pollMac();
    const receiving = sync.receive();
    await settle();
    // Only the poll is on the link; Receive waits its turn.
    expect(mac.reads).toEqual([null, 10]);
    mac.held.shift()?.();
    await polling;
    await settle();
    expect(mac.reads).toEqual([null, 10, -1]);
    // Receive's answer is the newer one, and it is the last word here.
    mac.copy("newer");
    mac.held.shift()?.();
    await receiving;
    expect(clipboard.writes).toEqual(["older", "newer"]);
    expect(clipboard.text).toBe("newer");
  });

  it("drops an automatic read of this computer's clipboard that a copy from the Mac overtook", async () => {
    const sync = makeSync();
    await sync.start();
    let release = (_text: string) => {};
    clipboard.readText = () => new Promise<string>((done) => (release = done));
    const checking = sync.check();
    mac.copy("from the Mac");
    await sync.pollMac();
    expect(clipboard.text).toBe("from the Mac");
    // The read began before that copy: what it saw is older, and is not sent over the Mac's.
    release("stale here");
    await checking;
    expect(mac.writes).toEqual([]);
  });
});

describe("a failed copy here, and Auto sync switched off (review pass 2)", () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    clipboardPreference.setAutoSync(true);
  });

  /** Holds this computer's clipboard reads until `release`; later reads answer at once. */
  function holdLocalRead(): (text: string) => void {
    let release = (_text: string) => {};
    const answer = clipboard.readText.bind(clipboard);
    clipboard.readText = () => {
      clipboard.readText = answer;
      return new Promise<string>((done) => (release = done));
    };
    return (text) => release(text);
  }

  it("never sends old text here over the Mac's newer text when copying the Mac's here failed", async () => {
    const sync = makeSync();
    await sync.start();
    clipboard.text = "old local";
    // Auto sync's first read of this computer's clipboard, held.
    const release = holdLocalRead();
    const checking = sync.check();
    // Meanwhile the Mac gets new text, and copying it here is refused.
    mac.copy("new Mac");
    clipboard.writable = false;
    await sync.pollMac();
    expect(clipboard.text).toBe("old local");
    release("old local");
    await checking;
    expect(mac.writes).toEqual([]);

    // The next check reads the same old text: still nothing is sent.
    clipboard.writable = true;
    later();
    await sync.check();
    expect(mac.writes).toEqual([]);
    expect(mac.text).toBe("new Mac");

    // A copy made here afterwards is new, and is sent.
    clipboard.text = "genuinely new";
    later();
    await sync.check();
    expect(mac.writes).toEqual(["genuinely new"]);
  });

  it("does not count a failed copy here as a change to this computer's clipboard", async () => {
    const sync = makeSync();
    await sync.start();
    clipboard.text = "kept";
    clipboard.writable = false;
    mac.copy("refused here");
    await sync.pollMac();
    clipboard.writable = true;
    // The first read after the failure is taken as what this computer holds.
    later();
    await sync.check();
    expect(mac.writes).toEqual([]);
  });

  it.each([
    ["switched off", () => clipboardPreference.setAutoSync(false)],
    ["switched off and on again", () => {
      clipboardPreference.setAutoSync(false);
      clipboardPreference.setAutoSync(true);
    }],
    ["hidden", () => {
      visibility = "hidden";
    }],
  ])("sends nothing a read began before Auto sync was %s", async (_what, change) => {
    const sync = makeSync();
    await sync.start();
    const release = holdLocalRead();
    const checking = sync.check();
    await settle();
    change();
    release("read before the change");
    await checking;
    expect(mac.attemptedWrites).toEqual([]);
  });

  it("leaves Send clipboard alone with Auto sync off", async () => {
    clipboardPreference.setAutoSync(false);
    const sync = makeSync();
    clipboard.text = "sent by hand";
    await sync.send();
    expect(mac.writes).toEqual(["sent by hand"]);
  });
});

describe("after the session ends (review pass 1)", () => {
  it("drops a Receive whose answer comes after the end", async () => {
    const sync = makeSync();
    await sync.start();
    const link = deferred();
    mac.gate = link.promise;
    mac.copy("from a closed session");
    const receiving = sync.receive();
    await settle();
    sync.end();
    // A new session may be open by now; the old answer must not reach the clipboard.
    link.resolve();
    mac.gate = null;
    await receiving;
    expect(clipboard.writes).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("drops a poll, a send and a step still queued at the end", async () => {
    clipboardPreference.setAutoSync(true);
    const sync = makeSync();
    await sync.start();
    const link = deferred();
    mac.gate = link.promise;
    mac.copy("on the Mac");
    clipboard.text = "here";
    const polling = sync.pollMac();
    const sending = sync.send();
    await settle();
    sync.end();
    link.resolve();
    mac.gate = null;
    await Promise.all([polling, sending]);
    expect(clipboard.writes).toEqual([]);
    expect(mac.writes).toEqual([]);
  });
});

describe("a hidden page (review pass 1)", () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    clipboardPreference.setAutoSync(true);
  });

  it("asks the Mac nothing while hidden, and again once shown", async () => {
    const sync = makeSync();
    await sync.start();
    visibility = "hidden";
    mac.copy("copied while hidden");
    await sync.pollMac();
    expect(mac.reads).toEqual([null]);
    expect(clipboard.writes).toEqual([]);
    visibility = "visible";
    await sync.pollMac();
    expect(clipboard.writes).toEqual(["copied while hidden"]);
  });

  it("drops an answer that arrives after the page was hidden, and asks again later", async () => {
    const sync = makeSync();
    await sync.start();
    const link = deferred();
    mac.gate = link.promise;
    mac.copy("answered late");
    const polling = sync.pollMac();
    await settle();
    visibility = "hidden";
    link.resolve();
    mac.gate = null;
    await polling;
    expect(clipboard.writes).toEqual([]);
    visibility = "visible";
    await sync.pollMac();
    expect(clipboard.writes).toEqual(["answered late"]);
  });

  it("still reads once as the screen leaves the page", async () => {
    const sync = makeSync();
    await sync.start();
    mac.copy("copied just before leaving");
    const leaving = sync.pollMac({ leaving: true });
    canSync = false;
    await leaving;
    expect(clipboard.writes).toEqual(["copied just before leaving"]);
  });
});

describe("a Mac that stops answering (review pass 1)", () => {
  it("becomes unavailable, stops polling, and comes back when a probe that reads the text succeeds", async () => {
    clipboardPreference.setAutoSync(true);
    const sync = makeSync();
    await sync.start();
    expect(accesses.at(-1)).toEqual({ available: true, account: mac.account });
    mac.copy("x");
    mac.error = new Error("the link dropped");
    await sync.pollMac();
    expect(accesses.at(-1)).toEqual({ available: false, reason: "Could not reach MacMini’s clipboard: the link dropped." });
    await sync.pollMac();
    await sync.pollMac();
    expect(mac.reads).toEqual([null, 10]);

    // The menu opening asks again: a probe that reads the text, which still fails.
    await sync.start();
    expect(mac.reads.at(-1)).toBe(-1);
    expect(accesses.at(-1)?.available).toBe(false);
    mac.error = null;
    await sync.start();
    expect(accesses.at(-1)).toEqual({ available: true, account: mac.account });
    // What the Mac held at the probe is known, so it is not copied as a change.
    await sync.pollMac();
    expect(clipboard.writes).toEqual([]);
    mac.copy("after recovery");
    await sync.pollMac();
    expect(clipboard.writes).toEqual(["after recovery"]);
  });

  it("refuses to send more than the clipboard syncs without calling the Mac", async () => {
    const sync = makeSync();
    clipboard.text = "é".repeat(600 * 1024);
    await sync.send();
    expect(mac.attemptedWrites).toEqual([]);
    expect(notices.at(-1)?.text).toBe("This computer’s clipboard holds more than 1 MB of text, more than the clipboard syncs.");
    expect(accesses.at(-1)?.available).toBe(true);
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
