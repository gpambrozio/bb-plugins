/**
 * The page's check that the relay is still there: a ping every few seconds,
 * and the session called lost when one goes unanswered with nothing else
 * arriving — the case a close event never reports (bb restarting behind the
 * getbb.app tunnel leaves the browser's socket open).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOST_AFTER_MS, PING_EVERY_MS, PING_FRAME, PONG_FRAME } from "../shared/channels";
import { watchRelay } from "./liveness";

class FakeSocket extends EventTarget {
  readyState = 1;
  texts: string[] = [];
  send(data: string): void {
    this.texts.push(data);
  }
  /** The relay sending a frame. */
  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

let socket: FakeSocket;
let lost: number;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket();
  lost = 0;
  stop = watchRelay(socket as unknown as WebSocket, () => lost++);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("the relay's liveness", () => {
  it("pings the relay every few seconds", () => {
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(socket.texts).toEqual([PING_FRAME]);
    socket.receive(PONG_FRAME);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(socket.texts).toEqual([PING_FRAME, PING_FRAME]);
  });

  it("calls the relay lost, once, when a ping goes unanswered and nothing else arrives", () => {
    vi.advanceTimersByTime(PING_EVERY_MS + LOST_AFTER_MS - 1);
    expect(lost).toBe(0);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(1);
    vi.advanceTimersByTime(10 * LOST_AFTER_MS);
    expect(lost).toBe(1);
    // One ping out at a time: nothing more was sent while waiting for the answer.
    expect(socket.texts).toEqual([PING_FRAME]);
  });

  it("stays quiet while pongs come back, or while the screen's bytes keep arriving instead", () => {
    for (let tick = 0; tick < 20; tick++) {
      vi.advanceTimersByTime(PING_EVERY_MS);
      socket.receive(tick % 2 === 0 ? PONG_FRAME : new ArrayBuffer(8));
    }
    expect(lost).toBe(0);
  });

  it("does not blame the relay for a timer the browser held back", () => {
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(socket.texts).toHaveLength(1);
    // A hidden tab's timers run late: the next tick comes long after the ping went out.
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(0);
    // It pings again and waits the full time for that answer, and no longer.
    expect(socket.texts).toHaveLength(2);
    vi.advanceTimersByTime(LOST_AFTER_MS - PING_EVERY_MS);
    expect(lost).toBe(0);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(1);
  });

  it("waits for the socket to open before pinging, and stops when told", () => {
    stop();
    socket = new FakeSocket();
    socket.readyState = 0;
    stop = watchRelay(socket as unknown as WebSocket, () => lost++);
    vi.advanceTimersByTime(3 * LOST_AFTER_MS);
    expect(socket.texts).toEqual([]);
    expect(lost).toBe(0);
    socket.readyState = 1;
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(socket.texts).toEqual([PING_FRAME]);
    stop();
    vi.advanceTimersByTime(3 * LOST_AFTER_MS);
    expect(lost).toBe(0);
  });
});
