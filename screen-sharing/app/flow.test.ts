/**
 * The page's acknowledgements: what arrives is counted and acknowledged at
 * most once per interval, in a text frame, and never after the socket closed
 * or the session stopped acknowledging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acknowledgeReceived } from "./flow";

class FakeSocket extends EventTarget {
  readyState = 1;
  sent: unknown[] = [];
  send(data: unknown): void {
    this.sent.push(data);
  }
  arrive(data: unknown): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("acknowledgeReceived", () => {
  it("acknowledges the running total, once per interval", () => {
    const socket = new FakeSocket();
    acknowledgeReceived(socket as unknown as WebSocket, 50);
    socket.arrive(new ArrayBuffer(10));
    socket.arrive(new Uint8Array(5));
    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(socket.sent).toEqual(["ack:15"]);
    vi.advanceTimersByTime(500);
    expect(socket.sent).toEqual(["ack:15"]);
    socket.arrive(new ArrayBuffer(100));
    vi.advanceTimersByTime(50);
    expect(socket.sent).toEqual(["ack:15", "ack:115"]);
  });

  it("sends nothing on a closed socket, or once stopped", () => {
    const socket = new FakeSocket();
    const stop = acknowledgeReceived(socket as unknown as WebSocket, 50);
    socket.arrive(new ArrayBuffer(10));
    socket.readyState = 3;
    vi.advanceTimersByTime(50);
    socket.readyState = 1;
    stop();
    socket.arrive(new ArrayBuffer(10));
    vi.advanceTimersByTime(50);
    expect(socket.sent).toEqual([]);
  });
});
