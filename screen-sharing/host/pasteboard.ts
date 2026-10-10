/**
 * The Mac's clipboard (its general pasteboard), as plain UTF-8 text, for the
 * page's Clipboard menu. The host entry runs it on each Mac (host.ts); the
 * server runs it for its own Mac (server.ts).
 *
 * macOS Screen Sharing does not carry the clipboard over standard RFB cut
 * text, and Apple's own pasteboard messages are only known to work in its
 * private 003.889 revision of the protocol, which noVNC does not speak
 * (AGENTS.md, *Clipboard*). So the
 * clipboard goes around the screen session: `pbpaste` and `pbcopy` here, with
 * a UTF-8 locale — without one they fall back to Mac Roman and turn the rest
 * into "?" — and the pasteboard's change count, read through JXA, so a page
 * watching for changes reads the text only when it changed.
 *
 * These act on the pasteboard of the macOS account this process runs as: the
 * account bb runs as on that Mac. Another account's desktop, signed in to
 * through Screen Sharing, has a pasteboard of its own, which only root could
 * reach. `account` names it, so the page can say when the two differ.
 */
import { execFile, spawn } from "node:child_process";
import { userInfo } from "node:os";

import { MAX_CLIPBOARD_BYTES, type ClipboardAccount, type ClipboardRead, type ClipboardWritten } from "../shared/channels";

/** Every command here is quick; one that hangs is cut off. */
const COMMAND_TIMEOUT_MS = 5_000;
/** UTF-8, whatever locale the process was started with; pbcopy and pbpaste read it from the environment. */
const UTF8_ENV = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
const CHANGE_COUNT_SCRIPT = 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount';

/** What the clipboard needs from macOS; tests replace it. */
export interface PasteboardCommands {
  platform: NodeJS.Platform;
  /** The account's short name. */
  userName(): string;
  /** The account's full name, if macOS gives one. */
  fullName(): Promise<string | null>;
  changeCount(): Promise<number>;
  /** The pasteboard's text, as UTF-8 bytes. */
  readText(): Promise<Buffer>;
  writeText(text: string): Promise<void>;
}

function run(file: string, args: string[], { maxBuffer = 64 * 1024 }: { maxBuffer?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: UTF8_ENV, timeout: COMMAND_TIMEOUT_MS, maxBuffer, encoding: "buffer" }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
}

export const macPasteboardCommands: PasteboardCommands = {
  platform: process.platform,
  userName: () => userInfo().username,
  fullName: async () => {
    try {
      const name = (await run("/usr/bin/id", ["-F"])).toString("utf8").trim();
      return name === "" ? null : name;
    } catch {
      return null;
    }
  },
  changeCount: async () => {
    const output = (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", CHANGE_COUNT_SCRIPT])).toString("utf8").trim();
    const count = Number(output);
    if (!Number.isInteger(count)) throw new Error(`unexpected pasteboard change count "${output.slice(0, 40)}"`);
    return count;
  },
  // One byte past the limit is enough to know the text is too long to sync.
  readText: () => run("/usr/bin/pbpaste", [], { maxBuffer: MAX_CLIPBOARD_BYTES + 1 }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return Buffer.alloc(MAX_CLIPBOARD_BYTES + 1);
    throw error;
  }),
  writeText: (text) =>
    new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/pbcopy", [], { env: UTF8_ENV, stdio: ["pipe", "ignore", "pipe"], timeout: COMMAND_TIMEOUT_MS });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pbcopy failed (${code ?? "killed"})${stderr === "" ? "" : `: ${stderr.trim()}`}`));
      });
      child.stdin.end(text, "utf8");
    }),
};

export class Pasteboard {
  private account: Promise<ClipboardAccount> | null = null;

  constructor(private readonly commands: PasteboardCommands = macPasteboardCommands) {}

  /**
   * The change count, the account, and the text when `since` is a count other
   * than the current one; `since: null` asks for no text. Text longer than
   * `MAX_CLIPBOARD_BYTES` comes back as its size alone.
   */
  async read(since: number | null): Promise<ClipboardRead> {
    this.requireMac();
    const [account, changeCount] = await Promise.all([this.whose(), this.commands.changeCount()]);
    if (since === null || since === changeCount) return { account, changeCount, text: null, tooLarge: false };
    const bytes = await this.commands.readText();
    if (bytes.length > MAX_CLIPBOARD_BYTES) return { account, changeCount, text: null, tooLarge: true };
    return { account, changeCount, text: bytes.toString("utf8"), tooLarge: false };
  }

  /** Puts `text` on the pasteboard; answers with the change count it now has. */
  async write(text: string): Promise<ClipboardWritten> {
    this.requireMac();
    if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) throw new Error("the text is longer than the clipboard syncs");
    await this.commands.writeText(text);
    const [account, changeCount] = await Promise.all([this.whose(), this.commands.changeCount()]);
    return { account, changeCount };
  }

  private requireMac(): void {
    if (this.commands.platform !== "darwin") throw new Error("this machine is not a Mac");
  }

  private whose(): Promise<ClipboardAccount> {
    this.account ??= this.commands.fullName().then((fullName) => ({ userName: this.commands.userName(), fullName }));
    return this.account;
  }
}
