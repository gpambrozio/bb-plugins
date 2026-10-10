/**
 * The Mac's clipboard (its general pasteboard), as plain UTF-8 text, for the
 * page's Clipboard menu. The host entry runs it on each Mac (host.ts); the
 * server runs it for its own Mac (server.ts).
 *
 * macOS Screen Sharing does not carry the clipboard over standard RFB cut
 * text, and Apple's own pasteboard messages are only known to work in its
 * private 003.889 revision of the protocol, which noVNC does not speak
 * (AGENTS.md, *Clipboard*). So the clipboard goes around the screen session,
 * through NSPasteboard itself, in JXA (`osascript -l JavaScript`):
 *
 * - **Plain text only, both ways.** It reads and writes the
 *   `public.utf8-plain-text` flavor and nothing else. `pbpaste` and `pbcopy`
 *   do not: `pbcopy` writes text that starts like RTF or EPS as that format,
 *   and `pbpaste` falls back to RTF or EPS when there is no plain text (their
 *   man page). A copied picture reads as no text.
 * - **A count that belongs to its text.** A read samples the change count
 *   before and after reading the text, and tries again if it moved; a write
 *   takes the count `clearContents` returns, the one its own write made, and
 *   fails if another copy took the pasteboard before its text was set. So the
 *   page never pairs a count with text the Mac does not hold.
 * - **UTF-8 throughout:** the text goes in on stdin and comes out on stdout as
 *   UTF-8 bytes, never through the locale or the command line.
 *
 * Every command runs through `runCommand`, which settles once: on exit, on a
 * spawn error, on an error writing stdin (EPIPE when the child exits before
 * reading it all), on its timeout and when its output passes its limit —
 * killing the child in every case but a normal exit.
 *
 * These act on the pasteboard of the macOS account this process runs as: the
 * account bb runs as on that Mac. Another account's desktop, signed in to
 * through Screen Sharing, has a pasteboard of its own, which only root could
 * reach. `account` names it, so the page can say when the two differ.
 */
import { spawn } from "node:child_process";
import { userInfo } from "node:os";

import { MAX_CLIPBOARD_BYTES, type ClipboardAccount, type ClipboardRead, type ClipboardWritten } from "../shared/channels";

/** Every command here is quick; one that hangs is cut off. */
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_ENV = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
/** The plain-text flavor, the only one read or written. */
const PLAIN_TEXT = "public.utf8-plain-text";

/** Every script's argv[0]: the pasteboard's name, empty for the general one (the clipboard). */
const PASTEBOARD = `const pasteboard = argv[0] === "" ? $.NSPasteboard.generalPasteboard : $.NSPasteboard.pasteboardWithName(argv[0]);`;

const CHANGE_COUNT_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  ${PASTEBOARD}
  return String(Number(pasteboard.changeCount));
}`;

/** argv[1]: the most UTF-8 bytes to send. Writes a JSON header line, then the text's bytes. */
const READ_SCRIPT = `ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  ${PASTEBOARD}
  const max = Number(argv[1]);
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const emit = (header, data) => {
    out.writeData($(JSON.stringify(header) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
    if (data !== undefined) out.writeData(data);
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const changeCount = Number(pasteboard.changeCount);
    const text = pasteboard.stringForType("${PLAIN_TEXT}");
    if (Number(pasteboard.changeCount) !== changeCount) continue;
    if (text.isNil()) return emit({ changeCount, text: false, tooLarge: false });
    const data = text.dataUsingEncoding($.NSUTF8StringEncoding);
    if (Number(data.length) > max) return emit({ changeCount, text: true, tooLarge: true });
    return emit({ changeCount, text: true, tooLarge: false }, data);
  }
  throw new Error("the pasteboard kept changing while it was read");
}`;

/** The text on stdin, as UTF-8. Writes a JSON line with the change count of this write. */
const WRITE_SCRIPT = `ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  ${PASTEBOARD}
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (text.isNil()) throw new Error("the text is not UTF-8");
  const changeCount = Number(pasteboard.clearContents);
  if (!pasteboard.setStringForType(text, "${PLAIN_TEXT}")) throw new Error("another copy took the pasteboard while it was written");
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify({ changeCount }) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
}`;

export interface RunOptions {
  /** Written to the child's stdin, which is closed after it (or at once without it). */
  input?: string;
  timeoutMs: number;
  /** Output past this many bytes kills the child and fails the run. */
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs a command and resolves with its stdout, or rejects — once, whichever
 * comes first: a non-zero exit, a spawn error (a missing executable), an error
 * on stdin (EPIPE: the child exited before reading all of it), the timeout, or
 * output past its limit. Every way but a normal exit kills the child, and
 * every stream error is handled, so none can reach the process as uncaught.
 */
export function runCommand(file: string, args: string[], options: RunOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? COMMAND_ENV, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const name = file.split("/").pop() ?? file;

    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) {
        resolve(Buffer.concat(chunks));
        return;
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      reject(error);
    }

    const timer = setTimeout(() => finish(new Error(`${name} did not finish within ${options.timeoutMs} ms`)), options.timeoutMs);
    child.on("error", (error) => finish(error));
    // EPIPE and the like: the child went away before taking its input. Its exit says why.
    child.stdin.on("error", (error) => finish(new Error(`${name} did not take its input: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) finish(new Error(`${name} wrote more than ${options.maxOutputBytes} bytes`));
      else chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (code === 0) finish(null);
      else finish(new Error(`${name} failed (${code ?? signal ?? "killed"})${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 300)}`}`));
    });
    child.stdin.end(options.input ?? "", "utf8");
  });
}

function jxa(script: string, args: string[], options: Omit<RunOptions, "timeoutMs"> & { timeoutMs?: number }): Promise<Buffer> {
  return runCommand("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...args], { timeoutMs: COMMAND_TIMEOUT_MS, ...options });
}

/** The first line of a script's output, as JSON, and the bytes after it. */
function splitHeader(output: Buffer): { header: Record<string, unknown>; rest: Buffer } {
  const end = output.indexOf(0x0a);
  if (end < 0) throw new Error("the pasteboard script gave no answer");
  return { header: JSON.parse(output.subarray(0, end).toString("utf8")) as Record<string, unknown>, rest: output.subarray(end + 1) };
}

function integer(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`unexpected ${what} "${String(value).slice(0, 40)}"`);
  return value;
}

/** The plain-text flavor and the change count it was read at. */
export interface PasteboardText {
  changeCount: number;
  /** Null when the pasteboard has no plain text (a picture, a file). */
  text: string | null;
  /** The text is longer than `MAX_CLIPBOARD_BYTES`; it is not read. */
  tooLarge: boolean;
}

/** What the clipboard needs from macOS; tests replace it. */
export interface PasteboardCommands {
  platform: NodeJS.Platform;
  /** The account's short name. */
  userName(): string;
  /** The account's full name, if macOS gives one. */
  fullName(): Promise<string | null>;
  changeCount(): Promise<number>;
  readText(): Promise<PasteboardText>;
  /** Replaces the pasteboard's contents with this plain text; the change count of that write. */
  writeText(text: string): Promise<number>;
}

/**
 * macOS's commands for a pasteboard: the general one — the clipboard — by
 * default; a named one only to try the scripts without touching the clipboard.
 */
export function macPasteboardCommandsFor(pasteboardName = ""): PasteboardCommands {
  return {
    platform: process.platform,
    userName: () => userInfo().username,
    fullName: async () => {
      try {
        const output = await runCommand("/usr/bin/id", ["-F"], { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: 4096 });
        const name = output.toString("utf8").trim();
        return name === "" ? null : name;
      } catch {
        return null;
      }
    },
    changeCount: async () => {
      const output = (await jxa(CHANGE_COUNT_SCRIPT, [pasteboardName], { maxOutputBytes: 256 })).toString("utf8").trim();
      return integer(Number(output), "pasteboard change count");
    },
    readText: async () => {
      const output = await jxa(READ_SCRIPT, [pasteboardName, String(MAX_CLIPBOARD_BYTES)], { maxOutputBytes: MAX_CLIPBOARD_BYTES + 1024 });
      const { header, rest } = splitHeader(output);
      const changeCount = integer(header.changeCount, "pasteboard change count");
      if (header.tooLarge === true) return { changeCount, text: null, tooLarge: true };
      return { changeCount, text: header.text === true ? rest.toString("utf8") : null, tooLarge: false };
    },
    writeText: async (text) => {
      const output = await jxa(WRITE_SCRIPT, [pasteboardName], { input: text, maxOutputBytes: 256 });
      return integer(splitHeader(output).header.changeCount, "pasteboard change count");
    },
  };
}

export const macPasteboardCommands = macPasteboardCommandsFor();

export class Pasteboard {
  private account: Promise<ClipboardAccount> | null = null;

  constructor(private readonly commands: PasteboardCommands = macPasteboardCommands) {}

  /**
   * The change count, the account, and the text when `since` is a count other
   * than the current one; `since: null` asks for no text. The text and the
   * count it comes with are read together. Text longer than
   * `MAX_CLIPBOARD_BYTES` comes back as its size alone.
   */
  async read(since: number | null): Promise<ClipboardRead> {
    this.requireMac();
    const [account, changeCount] = await Promise.all([this.whose(), this.commands.changeCount()]);
    if (since === null || since === changeCount) return { account, changeCount, text: null, tooLarge: false };
    const read = await this.commands.readText();
    return { account, changeCount: read.changeCount, text: read.text, tooLarge: read.tooLarge };
  }

  /** Puts `text` on the pasteboard as plain text; answers with the change count of that write. */
  async write(text: string): Promise<ClipboardWritten> {
    this.requireMac();
    if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) throw new Error("the text is longer than the clipboard syncs");
    const [account, changeCount] = await Promise.all([this.whose(), this.commands.writeText(text)]);
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
