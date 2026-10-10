/**
 * The host entry's handlers, built around one HostRelay per worker. A
 * factory, so the tests can point it at a fake Screen Sharing; host.ts builds
 * the real one, on port 5900.
 */
import { connect } from "node:net";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { MAX_CHUNK_BYTES, hostContract, hostSignals } from "../shared/host-contract";
import { Pasteboard } from "./pasteboard";
import { HostRelay } from "./relay";
import { checkScreenSharing, launchctlScreenSharingDisabled, probeRfb } from "./status";

export interface HostEntryOptions {
  port: number;
  /** Unacknowledged bytes allowed before reading from Screen Sharing pauses. */
  windowBytes: number;
  silenceMs: number;
  platform?: NodeJS.Platform;
  /** Stands in for launchctl in tests. */
  serviceDisabled?: () => Promise<boolean | null>;
  /** Stands in for the Mac's clipboard in tests. */
  pasteboard?: Pasteboard;
}

const MAX_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;

function log(message: string): void {
  console.info(`[screen-sharing] ${message}`);
}

export function createHostEntry(options: HostEntryOptions) {
  const relay = new HostRelay({
    connect: () => connect({ host: "127.0.0.1", port: options.port }),
    windowBytes: options.windowBytes,
    maxChunkBytes: MAX_CHUNK_BYTES,
    maxWriteBufferBytes: MAX_WRITE_BUFFER_BYTES,
    silenceMs: options.silenceMs,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    now: () => Date.now(),
    log,
  });
  const pasteboard = options.pasteboard ?? new Pasteboard();
  /** Every call carries the same worker lifecycle signal; listen to it once. */
  let watchingLifecycle = false;

  function watchLifecycle(signal: AbortSignal): void {
    if (watchingLifecycle) return;
    watchingLifecycle = true;
    const stop = () => relay.closeAll("the plugin's helper stopped");
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      status: () =>
        checkScreenSharing({
          platform: options.platform ?? process.platform,
          probe: () => probeRfb(options.port),
          serviceDisabled: options.serviceDisabled ?? (() => launchctlScreenSharingDisabled()),
        }),
      open: async ({ sessionId }, context) => {
        watchLifecycle(context.lifecycle.signal);
        // Taken while the call is live, as bb requires; the relay releases it when the session ends.
        const lease = context.experimental_retainWorker();
        await relay.open(
          sessionId,
          {
            emitData: (payload) => context.experimental_emitSignal("data", payload),
            emitClosed: (payload) => context.experimental_emitSignal("closed", payload),
            lease,
          },
          context.signal,
        );
        return {};
      },
      write: ({ sessionId, seq, data }) => {
        relay.write(sessionId, seq, data);
        return {};
      },
      ack: ({ sessionId, bytes }) => {
        relay.ack(sessionId, bytes);
        return {};
      },
      keepalive: ({ sessionId }) => ({ open: relay.keepalive(sessionId) }),
      close: ({ sessionId }) => {
        relay.close(sessionId);
        return {};
      },
      clipboardRead: ({ since }) => pasteboard.read(since),
      clipboardWrite: ({ text }) => pasteboard.write(text),
    },
    dispose: () => relay.closeAll("the plugin's helper stopped"),
  });
}
