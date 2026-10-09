/**
 * A session to the Mac running the bb server: one TCP connection to its
 * Screen Sharing on 127.0.0.1:5900, bytes copied untouched. Reading pauses
 * while more than `windowBytes` has gone to the viewer unacknowledged.
 */
import type { Socket } from "node:net";

import { CloseCode } from "../shared/channels";
import { errorCode, type Link, type LinkEvents } from "./link";

export interface LoopbackLinkOptions {
  socket: Socket;
  windowBytes: number;
  /** Bytes the viewer may send faster than Screen Sharing reads them before the session ends. */
  maxBufferedBytes: number;
}

export function createLoopbackLink(options: LoopbackLinkOptions, events: LinkEvents): Link {
  const { socket } = options;
  let delivered = 0;
  let acked = 0;
  let paused = false;
  let done = false;

  function end(code: number, reason: string): void {
    if (done) return;
    done = true;
    socket.destroy();
    events.end(code, reason);
  }

  function applyWindow(): void {
    const outstanding = delivered - acked;
    if (!paused && outstanding > options.windowBytes) {
      paused = true;
      socket.pause();
    } else if (paused && outstanding <= options.windowBytes) {
      paused = false;
      socket.resume();
    }
  }

  socket.on("data", (chunk: Buffer) => {
    if (done) return;
    delivered += chunk.length;
    events.data(new Uint8Array(chunk));
    applyWindow();
  });
  socket.on("error", (error) => end(CloseCode.failed, `cannot reach Screen Sharing (${errorCode(error)})`));
  socket.on("close", () => end(CloseCode.normal, "Screen Sharing closed the connection"));

  return {
    write(bytes) {
      if (done) return;
      socket.write(bytes);
      if (socket.writableLength > options.maxBufferedBytes) end(CloseCode.failed, "Screen Sharing is not reading");
    },
    ack(totalBytes) {
      if (done) return;
      acked = totalBytes;
      applyWindow();
    },
    close() {
      if (done) return;
      done = true;
      socket.destroy();
    },
  };
}
