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

  it("does not count a tick the browser ran 2 s late as silence, with the pong queued behind it", () => {
    vi.advanceTimersByTime(PING_EVERY_MS); // t=2: ping
    vi.advanceTimersByTime(PING_EVERY_MS); // t=4
    // The t=6 tick runs at t=8: a short sleep or a busy page, with the pong waiting to be handled.
    vi.setSystemTime(Date.now() + PING_EVERY_MS);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(0);
    // The pong is handled once the page runs again: the relay was there all along.
    socket.receive(PONG_FRAME);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(0);
    expect(socket.texts).toEqual([PING_FRAME, PING_FRAME]);
  });

  it.each([2_000, 4_000, 60_000])("gives a tick %i ms late a fresh grace period, so a dead relay ends the session a full wait later", (delay) => {
    vi.advanceTimersByTime(PING_EVERY_MS); // ping out
    vi.setSystemTime(Date.now() + delay);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(0);
    // From the late tick on, LOST_AFTER_MS of on-time ticks with nothing heard.
    vi.advanceTimersByTime(LOST_AFTER_MS - PING_EVERY_MS);
    expect(lost).toBe(0);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(1);
  });

  it.each([2_000, 60_000])("does not end the session on a final tick run %i ms late, before the queued pong is handled", (delay) => {
    vi.advanceTimersByTime(PING_EVERY_MS); // t=2: ping
    vi.advanceTimersByTime(LOST_AFTER_MS - PING_EVERY_MS); // t=4 and t=6: one interval short of the deadline
    expect(lost).toBe(0);
    // The page is suspended; the t=8 tick runs at t=8 + delay, ahead of the pong that arrived meanwhile.
    vi.setSystemTime(Date.now() + delay);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(0);
    socket.receive(PONG_FRAME);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(0);
  });

  it("gives the clock going backwards a fresh grace period too", () => {
    vi.advanceTimersByTime(PING_EVERY_MS);
    vi.advanceTimersByTime(LOST_AFTER_MS - PING_EVERY_MS);
    vi.setSystemTime(Date.now() - 3_600_000);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(0);
    vi.advanceTimersByTime(LOST_AFTER_MS - PING_EVERY_MS);
    expect(lost).toBe(0);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(lost).toBe(1);
  });

  it("still ends the session on time when ticks are only a little late", () => {
    vi.advanceTimersByTime(PING_EVERY_MS); // ping out
    // Every tick 0.9 s late: a busy page, not a suspended one.
    for (let tick = 0; tick < LOST_AFTER_MS / PING_EVERY_MS; tick++) {
      vi.setSystemTime(Date.now() + 900);
      vi.advanceTimersByTime(PING_EVERY_MS);
    }
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
