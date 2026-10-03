import { describe, expect, it } from "vitest";

import { createAnswerChannel } from "./answer-channel";

describe("createAnswerChannel", () => {
  it("hands each answer to every subscriber of its key, and only of its key", () => {
    const channel = createAnswerChannel<number>();
    const seen: string[] = [];
    channel.subscribe("a", (value) => seen.push(`a1:${value}`));
    channel.subscribe("a", (value) => seen.push(`a2:${value}`));
    channel.subscribe("b", (value) => seen.push(`b:${value}`));
    expect(channel.publish("a", 1, channel.ticket())).toBe(true);
    expect(seen).toEqual(["a1:1", "a2:1"]);
    expect(channel.last("a")).toBe(1);
    expect(channel.last("b")).toBeUndefined();
  });

  it("keeps a key's last answer only while something subscribes to it", () => {
    const channel = createAnswerChannel<number>();
    channel.publish("a", 1, channel.ticket());
    expect(channel.last("a")).toBeUndefined();
    const first = channel.subscribe("a", () => {});
    const second = channel.subscribe("a", () => {});
    channel.publish("a", 2, channel.ticket());
    first();
    expect(channel.last("a")).toBe(2);
    second();
    expect(channel.last("a")).toBeUndefined();
  });

  it("calls an unsubscribed listener no more", () => {
    const channel = createAnswerChannel<number>();
    const seen: number[] = [];
    const stop = channel.subscribe("a", (value) => seen.push(value));
    channel.subscribe("a", () => {});
    channel.publish("a", 1, channel.ticket());
    stop();
    channel.publish("a", 2, channel.ticket());
    expect(seen).toEqual([1]);
  });

  // The button's scan, asked for first, can answer after the popup's.
  it("drops an answer asked for before the last one published", () => {
    const channel = createAnswerChannel<string>();
    const seen: string[] = [];
    channel.subscribe("a", (value) => seen.push(value));
    const older = channel.ticket();
    const newer = channel.ticket();
    expect(channel.publish("a", "new", newer)).toBe(true);
    expect(channel.publish("a", "old", older)).toBe(false);
    expect(seen).toEqual(["new"]);
    expect(channel.last("a")).toBe("new");
  });

  it("orders each key on its own", () => {
    const channel = createAnswerChannel<string>();
    channel.subscribe("a", () => {});
    channel.subscribe("b", () => {});
    const forB = channel.ticket();
    channel.publish("a", "a", channel.ticket());
    expect(channel.publish("b", "b", forB)).toBe(true);
  });
});
