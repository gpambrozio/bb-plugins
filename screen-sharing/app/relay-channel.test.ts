/**
 * The socket as noVNC sees it: the relay's text frames kept out, and what
 * noVNC sends in one task gathered into one frame.
 */
import { describe, expect, it } from "vitest";

import { PONG_FRAME } from "../shared/channels";
import { RelayChannel } from "./relay-channel";

class FakeSocket extends EventTarget {
  binaryType: BinaryType = "blob";
  protocol = "";
  readyState = 1;
  frames: Uint8Array[] = [];
  closes: { code?: number; reason?: string }[] = [];
  send(data: Uint8Array): void {
    this.frames.push(new Uint8Array(data));
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const socket = new FakeSocket();
  const channel = new RelayChannel(socket as unknown as WebSocket);
  return { socket, channel };
}

describe("the relay channel noVNC reads", () => {
  it("passes the relay's binary frames to noVNC and keeps its text frames away", () => {
    const { socket, channel } = setup();
    const seen: unknown[] = [];
    channel.onmessage = (event) => seen.push(event.data);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    socket.dispatchEvent(new MessageEvent("message", { data: PONG_FRAME }));
    socket.dispatchEvent(new MessageEvent("message", { data: bytes }));
    expect(seen).toEqual([bytes]);
  });

  it("hands on open, error and close, and sets the socket's binary type", () => {
    const { socket, channel } = setup();
    const seen: string[] = [];
    channel.onopen = () => seen.push("open");
    channel.onerror = () => seen.push("error");
    channel.onclose = (event) => seen.push(`close ${(event as CloseEvent & { code: number }).code}`);
    channel.binaryType = "arraybuffer";
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new Event("error"));
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
    expect(seen).toEqual(["open", "error", "close 1006"]);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(channel.readyState).toBe(1);
  });

  it("sends what noVNC writes at once, and a gathered burst as one frame, copied before noVNC reuses its buffer", () => {
    const { socket, channel } = setup();
    channel.send(new Uint8Array([9]));
    expect(socket.frames).toEqual([new Uint8Array([9])]);
    const buffer = new Uint8Array(6);
    channel.gather(() => {
      buffer.set([5, 8, 0, 1, 0, 1]);
      channel.send(buffer);
      buffer.set([5, 0, 0, 1, 0, 1]);
      channel.send(buffer);
      expect(socket.frames).toHaveLength(1);
    });
    expect(socket.frames).toEqual([new Uint8Array([9]), new Uint8Array([5, 8, 0, 1, 0, 1, 5, 0, 0, 1, 0, 1])]);
  });

  it("sends nothing gathered once the socket has closed", () => {
    const { socket, channel } = setup();
    channel.gather(() => {
      channel.send(new Uint8Array([1]));
      channel.close();
    });
    expect(socket.closes).toHaveLength(1);
    expect(socket.frames).toEqual([]);
  });
});
