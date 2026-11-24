// Runs `bb <args…>` for a button: a plugin's command (`bb herald say …`) or one of bb's own.
//
// bb gives a plugin's app no call that runs a command-line command, plugin or not. What it does give is
// a terminal on any machine (`useSdk().terminals`), so the command runs in one on the bb server's
// machine, with the `bb` that bb installed there (Settings → General), and its last lines come back as
// a toast. The terminal is the SDK's, so it is closed when the command ends or after a minute.
//
// The terminal runs a POSIX `sh` wrapper in argv mode, so nothing is re-quoted by a shell: `$0` is the
// `bb` binary and `$@` the words. When the command ends the wrapper prints its exit status inside an
// OSC sequence terminals do not draw, then waits, so the output can be read before the terminal goes:
// bb drops an exited terminal, and a fast command would be gone before its output was read.
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

import { joinArgs } from "../shared/layout";

export const EXIT_MARKER = "\u001b]5253;duo-rail;exit;";
const BEL = "\u0007";
/** `sleep`, not `read`: a terminal nobody closes (the page went away) still ends, two minutes later. */
export const WRAPPER = `"$0" "$@"; status=$?; printf '\\033]5253;duo-rail;exit;%d\\007' "$status"; sleep 120`;

export const TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const SUMMARY_LINES = 6;
const SUMMARY_CHARS = 600;

export type BbCommandResult =
  | { outcome: "finished"; exitCode: number; output: string }
  | { outcome: "timed-out"; output: string }
  | { outcome: "unavailable"; reason: string };

type Sdk = Pick<PluginBrowserBbSdk, "system" | "terminals">;

export interface RunOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The exit status the wrapper printed, or null while the command still runs. */
export function exitStatus(text: string): number | null {
  const start = text.lastIndexOf(EXIT_MARKER);
  if (start < 0) return null;
  const end = text.indexOf(BEL, start);
  if (end < 0) return null;
  const code = Number(text.slice(start + EXIT_MARKER.length, end));
  return Number.isInteger(code) ? code : null;
}

/** Terminal output as plain text: escape sequences out (colours, the marker), carriage returns folded. */
export function plainText(text: string): string {
  return (
    text
      // OSC … BEL or ST
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // CSI sequences
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // anything else after ESC
      .replace(/\u001b[@-_]/g, "")
      .split("\n")
      // a carriage return redraws the line: keep what was drawn last
      .map((line) => line.replace(/\r$/, "").split("\r").at(-1) ?? "")
      .join("\n")
  );
}

/** The last few lines worth showing in a toast. */
export function summarize(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const tail = lines.slice(-SUMMARY_LINES).join("\n");
  return tail.length > SUMMARY_CHARS ? `…${tail.slice(-SUMMARY_CHARS)}` : tail;
}

export async function runBbCommand(sdk: Sdk, args: readonly string[], options: RunOptions = {}): Promise<BbCommandResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const cli = await sdk.system.experimental_cliCommand();
  if (!cli.supported || cli.installedPath === null) {
    return { outcome: "unavailable", reason: "bb's command-line tool is not installed on the bb server's machine. Install it in bb's Settings → General." };
  }
  const { primaryHostId } = await sdk.system.config();
  if (primaryHostId === null) return { outcome: "unavailable", reason: "bb has no machine to run the command on." };

  const terminal = await sdk.terminals.create({
    cols: 120,
    rows: 40,
    title: `bb ${joinArgs(args)}`,
    scope: { kind: "host_path", hostId: primaryHostId, cwd: null },
    start: { mode: "argv", argv: ["/bin/sh", "-c", WRAPPER, cli.installedPath, ...args] },
  });
  const decoder = new TextDecoder();
  let text = "";
  let sinceSeq: number | undefined;
  const deadline = now() + TIMEOUT_MS;
  try {
    for (;;) {
      const page = await sdk.terminals.output({ terminalId: terminal.id, ...(sinceSeq === undefined ? {} : { sinceSeq }) });
      for (const chunk of page.chunks) text += decoder.decode(decodeBase64(chunk.dataBase64), { stream: true });
      sinceSeq = page.nextSeq;
      const status = exitStatus(text);
      const output = plainText(text.slice(0, text.lastIndexOf(EXIT_MARKER) >= 0 ? text.lastIndexOf(EXIT_MARKER) : text.length));
      if (status !== null) return { outcome: "finished", exitCode: status, output };
      // The wrapper itself ended (killed, or a shell that could not start).
      if (page.status === "exited" || page.status === "disconnected") return { outcome: "finished", exitCode: page.exitCode ?? 1, output };
      if (now() >= deadline) return { outcome: "timed-out", output };
      await sleep(POLL_MS);
    }
  } finally {
    // The wrapper ends by itself two minutes on, so a close that fails leaves nothing running for long.
    await sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch((error: unknown) => console.warn("duo-rail: could not close the command's terminal", error));
  }
}
