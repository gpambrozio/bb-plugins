/**
 * Is Screen Sharing on, on the Mac running the bb server? Two read-only
 * checks, neither needing root:
 *
 * - `launchctl print-disabled system` says whether macOS has the
 *   `com.apple.screensharing` service switched off. Turning it on takes System
 *   Settings (or MDM); since macOS 12.1 no script can.
 * - A TCP connection to 127.0.0.1:5900 reads the RFB greeting and the list of
 *   sign-in methods, then hangs up before signing in.
 *
 * The greeting is what counts: Remote Management also answers on 5900 while
 * the Screen Sharing switch itself is off.
 */
import { execFile } from "node:child_process";
import { connect } from "node:net";

import type { ScreenState } from "../shared/channels";

/** The RFB security types noVNC can sign in with (core/rfb.js). */
const NOVNC_SECURITY_TYPES = new Set([1, 2, 6, 16, 19, 22, 30, 113, 256]);

export interface RfbProbe {
  /** e.g. "RFB 003.889". */
  version: string;
  securityTypes: number[];
}

export interface StatusChecks {
  platform: NodeJS.Platform;
  /** Null when nothing answers with an RFB greeting. */
  probe(): Promise<RfbProbe | null>;
  /** True or false when launchctl says so; null when it cannot tell. */
  serviceDisabled(): Promise<boolean | null>;
}

export interface ScreenCheck {
  state: ScreenState;
  rfbVersion: string | null;
  securityTypes: number[];
  signInSupported: boolean;
}

export async function checkScreenSharing(checks: StatusChecks): Promise<ScreenCheck> {
  if (checks.platform !== "darwin") {
    return { state: "unsupported", rfbVersion: null, securityTypes: [], signInSupported: false };
  }
  const probe = await checks.probe();
  if (probe !== null) {
    return {
      state: "ready",
      rfbVersion: probe.version,
      securityTypes: probe.securityTypes,
      signInSupported: probe.securityTypes.some((type) => NOVNC_SECURITY_TYPES.has(type)),
    };
  }
  const disabled = await checks.serviceDisabled();
  return { state: disabled === true ? "off" : "not-listening", rfbVersion: null, securityTypes: [], signInSupported: false };
}

/**
 * Reads `"com.apple.screensharing" => enabled` (or `disabled`, or the older
 * `false`/`true`) from `launchctl print-disabled system` output.
 */
export function parseScreenSharingDisabled(output: string): boolean | null {
  const match = output.match(/"com\.apple\.screensharing"\s*=>\s*(\w+)/);
  switch (match?.[1]) {
    case "disabled":
    case "true":
      return true;
    case "enabled":
    case "false":
      return false;
    default:
      return null;
  }
}

export function launchctlScreenSharingDisabled(timeoutMs = 3000): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("/bin/launchctl", ["print-disabled", "system"], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error === null ? parseScreenSharingDisabled(String(stdout)) : null);
    });
  });
}

/**
 * The RFB handshake up to the list of sign-in methods, and no further: the
 * server's version line, our version line, then the security types. RFB 3.3
 * servers send a single type as a 32-bit number instead of a list.
 */
export function probeRfb(port: number, timeoutMs = 3000, host = "127.0.0.1"): Promise<RfbProbe | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0);
    let version: string | null = null;
    let legacy = false;
    let settled = false;

    function settle(result: RfbProbe | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    const timer = setTimeout(() => settle(null), timeoutMs);

    socket.on("error", () => settle(null));
    socket.on("close", () => settle(null));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (version === null) {
        if (buffer.length < 12) return;
        const line = buffer.subarray(0, 12).toString("latin1");
        const match = line.match(/^RFB (\d{3})\.(\d{3})\n$/);
        if (match === null) return settle(null);
        version = line.trimEnd();
        legacy = Number(match[1]) === 3 && Number(match[2]) < 7;
        buffer = buffer.subarray(12);
        socket.write(legacy ? line : "RFB 003.008\n");
      }
      if (legacy) {
        if (buffer.length < 4) return;
        return settle({ version, securityTypes: [buffer.readUInt32BE(0)] });
      }
      if (buffer.length < 1) return;
      const count = buffer[0] ?? 0;
      // Zero types means the server refused us and a reason follows; we only report the empty list.
      if (buffer.length < 1 + count) return;
      settle({ version, securityTypes: [...buffer.subarray(1, 1 + count)] });
    });
  });
}
