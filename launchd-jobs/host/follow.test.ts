import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExperimentalHostWatchListener, ExperimentalHostWatchOptions } from "@get-bb/plugin-sdk";

import { createLogFollows, FOLLOW_TTL_MS, type FollowContext } from "./follow";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeContext() {
  const watches: { options: ExperimentalHostWatchOptions; listener: ExperimentalHostWatchListener; disposed: boolean }[] = [];
  const changed = vi.fn(async () => {});
  const context: FollowContext = {
    watch: async (options, listener) => {
      const watch = { options, listener, disposed: false };
      watches.push(watch);
      return {
        dispose: async () => {
          watch.disposed = true;
        },
      };
    },
    changed,
  };
  return { context, watches, changed };
}

describe("following a log", () => {
  it("watches the log's directory and signals when the log, or its rotation, changes", async () => {
    const follows = createLogFollows(() => {});
    const { context, watches, changed } = fakeContext();

    expect(await follows.follow("backup", "/data/logs/backup.log", context)).toBe(FOLLOW_TTL_MS);

    expect(watches).toHaveLength(1);
    expect(watches[0]?.options.rootPath).toBe("/data/logs");
    await watches[0]?.listener({ kind: "changed", changes: [{ path: "/data/logs/other.log", type: "update" }] });
    expect(changed).not.toHaveBeenCalled();
    await watches[0]?.listener({ kind: "changed", changes: [{ path: "/data/logs/backup.log", type: "update" }] });
    await watches[0]?.listener({ kind: "changed", changes: [{ path: "backup.log.1", type: "create" }] });
    await watches[0]?.listener({ kind: "rescan-required" });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("renews rather than doubling a follow, and ends it once nobody renews", async () => {
    const follows = createLogFollows(() => {});
    const { context, watches } = fakeContext();

    await follows.follow("backup", "/data/logs/backup.log", context);
    await vi.advanceTimersByTimeAsync(FOLLOW_TTL_MS - 1000);
    await follows.follow("backup", "/data/logs/backup.log", context);
    await vi.advanceTimersByTimeAsync(FOLLOW_TTL_MS - 1000);

    expect(watches).toHaveLength(1);
    expect(watches[0]?.disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(watches[0]?.disposed).toBe(true);
    expect(follows.following()).toEqual([]);
  });

  it("stops at once on unfollow and on dispose", async () => {
    const follows = createLogFollows(() => {});
    const { context, watches } = fakeContext();

    await follows.follow("a", "/data/logs/a.log", context);
    await follows.follow("b", "/data/logs/b.log", context);
    follows.unfollow("a");
    expect(watches.map((watch) => watch.disposed)).toEqual([true, false]);

    follows.dispose();
    expect(watches.map((watch) => watch.disposed)).toEqual([true, true]);
  });

  it("drops a watch that finished starting after the follow was stopped", async () => {
    const follows = createLogFollows(() => {});
    let release: () => void = () => {};
    let disposed = false;
    const context: FollowContext = {
      watch: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              dispose: async () => {
                disposed = true;
              },
            });
        }),
      changed: async () => {},
    };

    const pending = follows.follow("a", "/data/logs/a.log", context);
    follows.unfollow("a");
    release();
    await pending;

    expect(disposed).toBe(true);
    expect(follows.following()).toEqual([]);
  });
});
