import { describe, expect, it } from "vitest";

import { createAnswerChannel } from "./answer-channel";

describe("createAnswerChannel", () => {
  it("hands each answer to every subscriber of its key, and only of its key", () => {
    const channel = createAnswerChannel<number>();
    const seen: string[] = [];
    channel.subscribe("a", (value) => seen.push(`a1:${value}`));
    channel.subscribe("a", (value) => seen.push(`a2:${value}`));
    channel.subscribe("b", (value) => seen.push(`b:${value}`));
    channel.publish("a", 1);
    expect(seen).toEqual(["a1:1", "a2:1"]);
    expect(channel.last("a")).toBe(1);
    expect(channel.last("b")).toBeUndefined();
  });

  it("keeps a key's last answer only while something subscribes to it", () => {
    const channel = createAnswerChannel<number>();
    channel.publish("a", 1);
    expect(channel.last("a")).toBeUndefined();
    const first = channel.subscribe("a", () => {});
    const second = channel.subscribe("a", () => {});
    channel.publish("a", 2);
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
    channel.publish("a", 1);
    stop();
    channel.publish("a", 2);
    expect(seen).toEqual([1]);
  });
});
