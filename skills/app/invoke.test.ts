import { describe, expect, it, vi } from "vitest";

import { insertionText, invocationText, sendInvocation, withCommand, writesToThread } from "./invoke";

/** A send that answers only when the test says so. */
function deferredSend() {
  const sent: string[] = [];
  let settle: { resolve(): void; reject(error: Error): void } | undefined;
  const send = (text: string) => {
    sent.push(text);
    return new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  return {
    send,
    sent,
    resolve: () => settle?.resolve(),
    reject: (error: Error) => settle?.reject(error),
  };
}

/** One detail screen's lifetime: showing from mount until it is left. */
function screen() {
  let showing = true;
  return {
    isShowing: () => showing,
    leave() {
      showing = false;
    },
    onSent: vi.fn(),
    onFailure: vi.fn(),
    onUnseenFailure: vi.fn(),
  };
}

function start(
  send: (text: string) => Promise<unknown>,
  text: string,
  on: ReturnType<typeof screen>,
) {
  return sendInvocation({
    send,
    text,
    isShowing: on.isShowing,
    onSent: on.onSent,
    onFailure: on.onFailure,
    onUnseenFailure: on.onUnseenFailure,
  });
}

describe("invocationText", () => {
  it("sends the bare command without arguments, and trims them otherwise", () => {
    expect(invocationText("diff-check", "   ")).toBe("/diff-check");
    expect(invocationText("diff-check", "  focus on auth ")).toBe("/diff-check focus on auth");
  });
});

describe("sendInvocation", () => {
  it("reports success to the screen that is still showing", async () => {
    const network = deferredSend();
    const detail = screen();
    const done = start(network.send, "/diff-check", detail);
    network.resolve();
    await done;
    expect(network.sent).toEqual(["/diff-check"]);
    expect(detail.onSent).toHaveBeenCalledOnce();
  });

  it("leaves a newer selection alone when the first send answers after going back", async () => {
    const network = deferredSend();
    const first = screen();
    const done = start(network.send, "/diff-check", first);

    // "← All skills", then another skill: the first detail is gone, a second shows.
    first.leave();
    const second = screen();

    network.resolve();
    await done;
    expect(network.sent).toEqual(["/diff-check"]);
    expect(first.onSent).not.toHaveBeenCalled();
    expect(second.onSent).not.toHaveBeenCalled();
  });

  it("does not close a reopened popover when the send from the dismissed one answers", async () => {
    const network = deferredSend();
    const close = vi.fn();
    const dismissed = { ...screen(), onSent: close };
    const done = start(network.send, "/diff-check", dismissed);

    // Dismissing the popover unmounts its content; reopening mounts fresh content
    // whose `close` is the same host call.
    dismissed.leave();
    const reopened = { ...screen(), onSent: close };

    network.resolve();
    await done;
    expect(close).not.toHaveBeenCalled();
    expect(reopened.isShowing()).toBe(true);
  });

  it("keeps a failed send's screen open and shows the error there", async () => {
    const network = deferredSend();
    const detail = screen();
    const done = start(network.send, "/diff-check", detail);
    network.reject(new Error("thread is busy"));
    await done;
    expect(detail.onFailure).toHaveBeenCalledWith("thread is busy");
    expect(detail.onSent).not.toHaveBeenCalled();
    expect(detail.onUnseenFailure).not.toHaveBeenCalled();
  });

  it("still reports a failure nobody is looking at any more", async () => {
    const network = deferredSend();
    const detail = screen();
    const done = start(network.send, "/diff-check", detail);
    detail.leave();
    network.reject(new Error("thread is gone"));
    await done;
    expect(detail.onFailure).not.toHaveBeenCalled();
    expect(detail.onUnseenFailure).toHaveBeenCalledWith("thread is gone");
  });
});

describe("insertionText", () => {
  it("is the command, any trimmed arguments, and a trailing space", () => {
    expect(insertionText("diff-check", "")).toBe("/diff-check ");
    expect(insertionText("diff-check", "  src only ")).toBe("/diff-check src only ");
  });
});

describe("withCommand", () => {
  it("fills an empty or blank draft with the command", () => {
    expect(withCommand("", "/diff-check ")).toBe("/diff-check ");
    expect(withCommand("  \n", "/diff-check ")).toBe("/diff-check ");
  });

  it("puts the command first and keeps what was typed after it", () => {
    expect(withCommand("  look at auth.ts\nplease", "/diff-check ")).toBe("/diff-check look at auth.ts\nplease");
  });
});

describe("writesToThread", () => {
  it("accepts the thread's own draft and its queued messages", () => {
    expect(writesToThread({ kind: "thread", threadId: "thr_a" }, "thr_a")).toBe(true);
    expect(writesToThread({ kind: "queued-message", threadId: "thr_a" }, "thr_a")).toBe(true);
  });

  it("refuses another thread, a side chat and the new-thread composer", () => {
    expect(writesToThread({ kind: "thread", threadId: "thr_b" }, "thr_a")).toBe(false);
    expect(writesToThread({ kind: "side-chat" }, "thr_a")).toBe(false);
    expect(writesToThread({ kind: "new-thread" }, "thr_a")).toBe(false);
  });
});
