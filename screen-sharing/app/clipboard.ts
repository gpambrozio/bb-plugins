/**
 * Clipboard text between the computer in front of the user and the Mac:
 * Send clipboard, Receive clipboard, and Auto sync, which does both whenever
 * either side's clipboard changes. Text only, any characters (UTF-8).
 *
 * - **Not through the screen session.** macOS Screen Sharing does not carry
 *   the clipboard over standard RFB cut text, and Apple's own pasteboard
 *   messages are known to work only in its private 003.889 revision of the
 *   protocol, which noVNC does not speak (AGENTS.md, *Clipboard*). So the
 *   page asks the plugin's server for the Mac's clipboard (`clipboardRead`,
 *   `clipboardWrite`), which reads and writes it with `pbpaste` and `pbcopy`
 *   on that Mac (host/pasteboard.ts).
 * - **Whose clipboard.** That is the clipboard of the macOS account bb runs as
 *   on the Mac. A Screen Sharing sign-in as another account shows that
 *   account's own desktop, whose clipboard only root could reach; the sync
 *   then stays off and says why.
 * - **The Mac's changes** are found by watching its pasteboard change count,
 *   once a second while Auto sync is on and the screen is on the page, and
 *   once more as the screen leaves it; the text is read only when it moved.
 * - **Reading this computer's clipboard** is `navigator.clipboard.readText`.
 *   Browsers allow it only to a focused page, and some (Safari, Firefox, the
 *   mobile app's web view) only within a click; Chrome asks once. So Auto sync
 *   reads it only at moments the user is likely to have copied something —
 *   the session connecting, the screen coming on the page, the window or tab
 *   coming back, the pointer or focus entering the screen — one read at a
 *   time, and stops after the first refusal, saying so, until the user turns
 *   Auto sync on again or presses Send clipboard. This side is not polled.
 * - **Writing it** is bb's own clipboard writer (`experimental_copyToClipboard`):
 *   bb's desktop app writes the native clipboard, focused or not; a browser
 *   needs focus, and Safari a click. Receive asks the Mac first, so where the
 *   write needs a click of its own the notice offers a Copy button.
 * - **Only changes cross.** The sync keeps what each side was last known to
 *   hold. Auto sync sends this computer's clipboard only when it reads text
 *   other than what it last read or wrote there, and copies the Mac's only
 *   when it differs from that; so the Mac's count moving for text that came
 *   from here changes nothing, and a copy here that failed does not send the
 *   old text back over the Mac's new one.
 */
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";

import { MAX_CLIPBOARD_BYTES, type ClipboardAccount, type ClipboardRead, type ClipboardWritten } from "../shared/channels";

/** The clipboard of the computer in front of the user. */
export interface LocalClipboard {
  /** Rejects when the browser will not let the page read it now. */
  readText(): Promise<string>;
  /** Resolves false when every way to write failed; never rejects. */
  writeText(text: string): Promise<boolean>;
}

export const browserClipboard: LocalClipboard = {
  readText: async () => {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.readText !== "function") {
      throw new Error("this browser gives pages no way to read the clipboard");
    }
    return navigator.clipboard.readText();
  },
  // Called before anything is awaited, so a browser that writes only within a click sees the click.
  writeText: async (text) => {
    try {
      return await experimental_copyToClipboard({ text });
    } catch (error) {
      console.warn("[screen-sharing] could not write the clipboard", error);
      return false;
    }
  },
};

/** The Mac's clipboard, through the plugin's server; the page passes its RPC client's calls. */
export interface MacClipboard {
  /** The change count, and the text when `since` is a count other than the current one. */
  read(since: number | null): Promise<ClipboardRead>;
  write(text: string): Promise<ClipboardWritten>;
}

/** What a clipboard sync needs from its session. */
export interface ClipboardSession {
  /** The Mac takes input now: connected, on the page and not View only. */
  canSync(): boolean;
  hostName(): string;
  /** The user name typed at sign-in, if macOS asked for one. */
  signedInAs(): string | null;
}

export interface ClipboardNotice {
  tone: "info" | "warning";
  text: string;
  /** Text from the Mac this browser would copy only on a click of its own: the notice offers Copy. */
  copy?: string;
}

/**
 * Whether clipboard sync can work for the session, once the Mac has answered:
 * the account whose clipboard it reaches, or why it cannot — a sign-in as
 * another account, or a Mac whose clipboard could not be reached.
 */
export type ClipboardAccess = { available: true; account: ClipboardAccount } | { available: false; reason: string };

/** Whether the user name typed at sign-in names this account: macOS takes the short or the full name. */
export function signedInAsAccount(typed: string, account: ClipboardAccount): boolean {
  const name = typed.trim().toLowerCase();
  return name === account.userName.toLowerCase() || (account.fullName !== null && name === account.fullName.trim().toLowerCase());
}

/** Why the sync is off when the sign-in was another account's. */
export function wrongAccount(hostName: string, account: ClipboardAccount): string {
  return `Clipboard sync reaches only the clipboard of ${account.userName}, the account bb runs as on ${hostName}. Sign in as ${account.userName} to use it.`;
}

/** Auto sync, remembered on this computer for every session and the next ones. */
const AUTO_SYNC_KEY = "screen-sharing:clipboard-auto-sync";

class ClipboardPreference {
  private value: boolean | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getAutoSync = (): boolean => {
    if (this.value === null) {
      try {
        this.value = globalThis.localStorage?.getItem(AUTO_SYNC_KEY) === "on";
      } catch {
        this.value = false;
      }
    }
    return this.value;
  };

  setAutoSync(on: boolean): void {
    this.value = on;
    try {
      if (on) globalThis.localStorage?.setItem(AUTO_SYNC_KEY, "on");
      else globalThis.localStorage?.removeItem(AUTO_SYNC_KEY);
    } catch (error) {
      console.warn("[screen-sharing] could not remember Auto sync clipboard", error);
    }
    for (const listener of this.listeners) listener();
  }

  /** Forgets the remembered choice: a fresh computer, for tests. */
  reset(): void {
    this.setAutoSync(false);
    this.value = null;
  }
}

export const clipboardPreference = new ClipboardPreference();

/** How often the Mac's clipboard is checked for a change while Auto sync is on and the screen is shown. */
export const MAC_POLL_MS = 1_000;
/** Automatic reads of this computer's clipboard closer together than this are skipped: the pointer crossing the screen's edge, say. */
const AUTO_READ_GAP_MS = 500;
const MAX_CLIPBOARD_MEGABYTES = MAX_CLIPBOARD_BYTES / (1024 * 1024);

function errorText(error: unknown): string {
  // Browsers' messages often end in a full stop; the sentences here add their own.
  const message = error instanceof Error || error instanceof DOMException ? error.message : String(error);
  return message.replace(/\.$/, "");
}

function tooLarge(hostName: string): string {
  return `${hostName}’s clipboard holds more than ${MAX_CLIPBOARD_MEGABYTES} MB of text, more than the clipboard syncs.`;
}

/** One session's clipboard sync. The session makes one per connection. */
export class ClipboardSync {
  /** The Mac's pasteboard change count when last read. */
  private macCount: number | null = null;
  /** What the Mac's clipboard was last known to hold: sent or read. */
  private macHolds: string | null = null;
  /** What this computer's clipboard was last known to hold: read or written. */
  private localHolds: string | null = null;
  private access: ClipboardAccess | null = null;
  /** The first read of the Mac: its count, and whose clipboard it is. Everything else waits for it. */
  private ready: Promise<void> | null = null;
  private reading = false;
  private polling = false;
  private lastAutoRead = 0;
  /** The browser refused an automatic read; none is tried again until the user asks. */
  private autoReadRefused = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ended = false;

  constructor(
    private readonly session: ClipboardSession,
    private readonly mac: MacClipboard,
    private readonly notify: (notice: ClipboardNotice) => void,
    private readonly onAccess: (access: ClipboardAccess) => void,
    private readonly clipboard: LocalClipboard = browserClipboard,
  ) {}

  /**
   * The session is connected: learns whose clipboard the Mac's is, and starts
   * watching it. After a Mac that could not be reached, calling it again tries
   * again (the menu does as it opens).
   */
  start(): Promise<void> {
    if (this.pollTimer === null && !this.ended) this.pollTimer = setInterval(() => void this.pollMac(), MAC_POLL_MS);
    this.ready ??= this.mac
      .read(null)
      .then((read) => {
        this.macCount = read.changeCount;
        const typed = this.session.signedInAs();
        const signedInAsOther = typed !== null && !signedInAsAccount(typed, read.account);
        this.setAccess(
          signedInAsOther
            ? { available: false, reason: wrongAccount(this.session.hostName(), read.account) }
            : { available: true, account: read.account },
        );
      })
      .catch((error: unknown) => {
        this.setAccess({ available: false, reason: `Could not reach ${this.session.hostName()}’s clipboard: ${errorText(error)}.` });
        this.ready = null;
      });
    return this.ready;
  }

  /** The session is over: nothing more is sent, copied or said. */
  end(): void {
    this.ended = true;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Send clipboard: this computer's clipboard to the Mac, now. The clipboard
   * is read before anything is awaited, so a browser that allows it only
   * within a click sees the click.
   */
  async send(): Promise<void> {
    this.autoReadRefused = false;
    const reading = this.clipboard.readText();
    reading.catch(() => undefined);
    if (!(await this.usable())) return;
    let text: string;
    try {
      text = await reading;
    } catch (error) {
      this.say({ tone: "warning", text: `bb could not read this computer’s clipboard: ${errorText(error)}.` });
      return;
    }
    this.localHolds = text;
    if (text === "") {
      this.say({ tone: "info", text: "This computer’s clipboard holds no text." });
      return;
    }
    if (await this.push(text)) this.say({ tone: "info", text: `Sent this computer’s clipboard to ${this.session.hostName()}.` });
  }

  /** Receive clipboard: the Mac's clipboard, onto this computer's. */
  async receive(): Promise<void> {
    if (!(await this.usable())) return;
    const hostName = this.session.hostName();
    let read: ClipboardRead;
    try {
      // A count the Mac never has, so the text always comes back.
      read = await this.mac.read(-1);
    } catch (error) {
      this.say({ tone: "warning", text: `Could not read ${hostName}’s clipboard: ${errorText(error)}.` });
      return;
    }
    this.macCount = read.changeCount;
    if (read.tooLarge) {
      this.say({ tone: "warning", text: tooLarge(hostName) });
      return;
    }
    const text = read.text ?? "";
    if (text === "") {
      this.say({ tone: "info", text: `${hostName}’s clipboard holds no text.` });
      return;
    }
    this.macHolds = text;
    await this.copyHere(text, { offerCopy: true });
  }

  /** The notice's Copy button: a click of its own, which a browser that writes only within one allows. */
  copyFromNotice(text: string): Promise<void> {
    return this.copyHere(text, { offerCopy: false });
  }

  /**
   * Auto sync: sends this computer's clipboard if it changed. `asked` is the
   * user turning Auto sync on — a click, so a browser that reads the
   * clipboard only within one may allow it, and a refusal before is retried.
   */
  async check({ asked = false }: { asked?: boolean } = {}): Promise<void> {
    if (asked) this.autoReadRefused = false;
    if (!clipboardPreference.getAutoSync() || this.autoReadRefused || this.reading || this.ended) return;
    if (!this.session.canSync() || (typeof document !== "undefined" && !document.hasFocus())) return;
    const now = Date.now();
    if (!asked && now - this.lastAutoRead < AUTO_READ_GAP_MS) return;
    this.lastAutoRead = now;
    this.reading = true;
    let text: string;
    try {
      // Read before the first await, for a browser that reads only within a click.
      const reading = this.clipboard.readText();
      reading.catch(() => undefined);
      if (!(await this.usable({ quiet: true }))) return;
      text = await reading;
    } catch (error) {
      this.autoReadRefused = true;
      this.say({
        tone: "warning",
        text: `Auto sync can’t read this computer’s clipboard here (${errorText(error)}), so it won’t send it on its own. Use Send clipboard.`,
      });
      return;
    } finally {
      this.reading = false;
    }
    // Only a change on this computer is sent: text it already held, or was given by the Mac, is not.
    if (text === this.localHolds) return;
    this.localHolds = text;
    if (text === "" || text === this.macHolds) return;
    await this.push(text);
  }

  /**
   * Auto sync: copies the Mac's clipboard here if it changed. Runs every
   * `MAC_POLL_MS` while the screen is on the page, and as it leaves it.
   */
  async pollMac(): Promise<void> {
    if (!clipboardPreference.getAutoSync() || this.polling || this.ended || this.macCount === null) return;
    if (!this.session.canSync() || this.access?.available !== true) return;
    this.polling = true;
    let read: ClipboardRead;
    try {
      read = await this.mac.read(this.macCount);
    } catch (error) {
      this.say({ tone: "warning", text: `Could not read ${this.session.hostName()}’s clipboard: ${errorText(error)}.` });
      return;
    } finally {
      this.polling = false;
    }
    if (this.ended || read.changeCount === this.macCount) return;
    this.macCount = read.changeCount;
    if (read.tooLarge) {
      this.say({ tone: "warning", text: tooLarge(this.session.hostName()) });
      return;
    }
    const text = read.text ?? "";
    // Nothing to copy for a copied picture or file, and nothing new for text that came from here.
    if (text === "" || text === this.macHolds) return;
    this.macHolds = text;
    if (text === this.localHolds) return;
    // Left as it was when the write fails, so the next read does not send the old text back over this.
    if (await this.clipboard.writeText(text)) this.localHolds = text;
    else this.say({ tone: "warning", text: `Could not copy ${this.session.hostName()}’s clipboard here on its own. Use Receive clipboard.` });
  }

  private async copyHere(text: string, { offerCopy }: { offerCopy: boolean }): Promise<void> {
    const hostName = this.session.hostName();
    if (await this.clipboard.writeText(text)) {
      this.localHolds = text;
      this.say({ tone: "info", text: `Copied ${hostName}’s clipboard to this computer.` });
    } else if (offerCopy) {
      this.say({ tone: "warning", text: `This browser needs one more click to copy ${hostName}’s clipboard here.`, copy: text });
    } else {
      this.say({ tone: "warning", text: "bb could not write to this computer’s clipboard." });
    }
  }

  /** Whether the Mac's clipboard can be used: it answered, and it is the signed-in account's. */
  private async usable({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> {
    await this.start();
    const access = this.access;
    if (this.ended || access === null) return false;
    if (!access.available) {
      if (!quiet) this.say({ tone: "warning", text: access.reason });
      return false;
    }
    return true;
  }

  private setAccess(access: ClipboardAccess): void {
    this.access = access;
    if (!this.ended) this.onAccess(access);
  }

  /** Puts `text` on the Mac's clipboard; false, having said why, when that failed. */
  private async push(text: string): Promise<boolean> {
    if (this.ended || !this.session.canSync()) return false;
    try {
      const written = await this.mac.write(text);
      this.macHolds = text;
      this.macCount = written.changeCount;
      return true;
    } catch (error) {
      this.say({ tone: "warning", text: `Could not put the text on ${this.session.hostName()}’s clipboard: ${errorText(error)}.` });
      return false;
    }
  }

  private say(notice: ClipboardNotice): void {
    if (!this.ended) this.notify(notice);
  }
}
