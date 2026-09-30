import { describe, expect, it } from "vitest";

import { createSendGate, mateSendGate } from "./send-gate";

describe("createSendGate", () => {
  it("sends once for a double press, and again once the first has settled", async () => {
    const gate = createSendGate();
    const sent: string[] = [];
    let finish = (): void => {};
    function press(prompt: string): Promise<void> | null {
      return gate.run(function () {
        sent.push(prompt);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
    }
    const first = press("Land web#42");
    expect(press("Land web#42")).toBeNull();
    expect(gate.busy()).toBe(true);
    finish();
    await first;
    expect(gate.busy()).toBe(false);
    const second = press("Review loop on web#42");
    expect(second).not.toBeNull();
    finish();
    await second;
    expect(sent).toEqual(["Land web#42", "Review loop on web#42"]);
  });

  it("opens again after a failed send, and tells its listeners each time", async () => {
    const gate = createSendGate();
    const seen: boolean[] = [];
    const stop = gate.subscribe(() => seen.push(gate.busy()));
    await expect(gate.run(() => Promise.reject(new Error("daemon away")))).rejects.toThrow("daemon away");
    expect(gate.busy()).toBe(false);
    await expect(
      gate.run(() => {
        throw new Error("thrown before a promise");
      }),
    ).rejects.toThrow("thrown before a promise");
    expect(gate.busy()).toBe(false);
    stop();
    expect(seen).toEqual([true, false, true, false]);
  });

  it("stops telling a listener that has unsubscribed", async () => {
    const gate = createSendGate();
    let calls = 0;
    gate.subscribe(() => (calls += 1))();
    await gate.run(() => Promise.resolve());
    expect(calls).toBe(0);
  });
});

describe("mateSendGate", () => {
  it("is one gate for the life of the bundle, so a remount finds a send still out", async () => {
    let finish = (): void => {};
    const sending = mateSendGate.run(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(mateSendGate.busy()).toBe(true);
    expect(mateSendGate.run(() => Promise.resolve())).toBeNull();
    finish();
    await sending;
    expect(mateSendGate.busy()).toBe(false);
  });
});
