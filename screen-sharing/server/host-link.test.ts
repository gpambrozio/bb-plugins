/**
 * The server's side of a remote session against a scripted host client:
 * writes are pipelined up to the limit and numbered in order, only the latest
 * acknowledgement is forwarded, a quiet session is kept alive and ended when
 * its host no longer has it, and a session ended while its Mac was still
 * connecting is closed there once it connects.
 */
import { describe, expect, it } from "vitest";

import { CloseCode } from "../shared/channels";
import { HostLinks, type HostClient } from "./host-link";

interface PendingCall {
  method: string;
  input: Record<string, unknown>;
  options: { hostId: string; timeoutMs?: number };
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function scripted() {
  const calls: PendingCall[] = [];
  const client = {
    call: (method: string, input: Record<string, unknown>, options: PendingCall["options"]) =>
      new Promise((resolve, reject) => calls.push({ method, input, options, resolve, reject })),
  } as unknown as HostClient;
  return { calls, client };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const { calls, client } = scripted();
  let now = 0;
  const ended: { code: number; reason: string }[] = [];
  const data: Uint8Array[] = [];
  const links = new HostLinks({
    client,
    maxPipelinedWrites: 2,
    maxQueuedBytes: 1024,
    keepaliveMs: 60_000,
    keepaliveTimeoutMs: 10_000,
    openTimeoutMs: 15_000,
    now: () => now,
    log: () => {},
  });
  const link = links.open(
    { hostId: "host_laptop", hostName: "MacBook Pro", sessionId: "s1" },
    { data: (bytes) => data.push(bytes), end: (code, reason) => ended.push({ code, reason }) },
  );
  return {
    calls,
    links,
    link,
    ended,
    data,
    advance: (ms: number) => {
      now += ms;
    },
    method: (name: string) => calls.filter((call) => call.method === name),
  };
}

describe("a host link", () => {
  it("waits for the Mac to connect, then sends what the viewer typed meanwhile", async () => {
    const { calls, link, method } = setup();
    link.write(new Uint8Array([1]));
    link.write(new Uint8Array([2]));
    expect(calls.map((call) => call.method)).toEqual(["open"]);
    calls[0]?.resolve({});
    await flush();
    expect(method("write").map((call) => call.input)).toEqual([{ sessionId: "s1", seq: 0, data: Buffer.from([1, 2]).toString("base64") }]);
  });

  it("keeps a bounded number of writes in flight, numbered in order", async () => {
    const { calls, link, method } = setup();
    calls[0]?.resolve({});
    await flush();
    link.write(new Uint8Array([1]));
    link.write(new Uint8Array([2]));
    link.write(new Uint8Array([3]));
    link.write(new Uint8Array([4]));
    // Two in flight; the rest wait and go together.
    expect(method("write").map((call) => call.input.seq)).toEqual([0, 1]);
    method("write")[0]?.resolve({});
    await flush();
    expect(method("write").map((call) => [call.input.seq, call.input.data])).toEqual([
      [0, Buffer.from([1]).toString("base64")],
      [1, Buffer.from([2]).toString("base64")],
      [2, Buffer.from([3, 4]).toString("base64")],
    ]);
  });

  it("never runs more than its window past a write still unanswered, however fast the later ones are answered", async () => {
    const { calls, link, method } = setup();
    calls[0]?.resolve({});
    await flush();
    // The host answers every write but the first at once, as it does for one that overtook it.
    for (let key = 0; key < 40; key++) {
      link.write(new Uint8Array([key]));
      for (const call of method("write")) if (call.input.seq !== 0) call.resolve({});
      await flush();
    }
    // Window 2 (setup): with write 0 unanswered, nothing past write 1 goes out.
    expect(method("write").map((call) => call.input.seq)).toEqual([0, 1]);
    method("write")[0]?.resolve({});
    await flush();
    for (let round = 0; round < 40; round++) {
      for (const call of method("write")) call.resolve({});
      await flush();
    }
    const sent = method("write");
    expect(sent.map((call) => call.input.seq)).toEqual(sent.map((_, index) => index));
    const bytes = Buffer.concat(sent.map((call) => Buffer.from(String(call.input.data), "base64")));
    expect([...bytes]).toEqual(Array.from({ length: 40 }, (_, key) => key));
  });

  it("ends the session when the viewer sends faster than the Mac takes it", async () => {
    const { calls, link, ended } = setup();
    calls[0]?.resolve({});
    await flush();
    link.write(new Uint8Array(1025));
    expect(ended).toEqual([{ code: CloseCode.failed, reason: "MacBook Pro: Screen Sharing is not reading" }]);
  });

  it("forwards only the latest acknowledgement, one call at a time", async () => {
    const { calls, link, method } = setup();
    link.ack(10);
    calls[0]?.resolve({});
    await flush();
    // Acknowledged while the Mac was connecting: sent once it is.
    expect(method("ack").map((call) => call.input.bytes)).toEqual([10]);
    link.ack(20);
    link.ack(30);
    expect(method("ack").map((call) => call.input.bytes)).toEqual([10]);
    method("ack")[0]?.resolve({});
    await flush();
    expect(method("ack").map((call) => call.input.bytes)).toEqual([10, 30]);
  });

  it("keeps a quiet session alive, and ends it when its Mac no longer has it", async () => {
    const { calls, links, ended, method, advance } = setup();
    calls[0]?.resolve({});
    await flush();
    advance(59_000);
    links.keepalive();
    expect(method("keepalive")).toEqual([]);
    advance(1_000);
    links.keepalive();
    links.keepalive();
    expect(method("keepalive")).toHaveLength(1);
    // A keepalive that hangs counts as lost after its own short timeout, not bb's default 30 s.
    expect(method("keepalive")[0]?.options).toEqual({ hostId: "host_laptop", timeoutMs: 10_000 });
    method("keepalive")[0]?.resolve({ open: true });
    await flush();
    expect(ended).toEqual([]);

    advance(60_000);
    links.keepalive();
    method("keepalive")[1]?.resolve({ open: false });
    await flush();
    expect(ended).toEqual([{ code: CloseCode.failed, reason: "MacBook Pro: the Mac no longer has this session" }]);
    expect(links.size).toBe(0);
  });

  it("ends the session when a keepalive cannot reach the Mac", async () => {
    const { calls, links, ended, method, advance } = setup();
    calls[0]?.resolve({});
    await flush();
    advance(60_000);
    links.keepalive();
    method("keepalive")[0]?.reject(new Error("host is not connected"));
    await flush();
    expect(ended).toEqual([{ code: CloseCode.failed, reason: "MacBook Pro: lost the connection (host is not connected)" }]);
  });

  it("closes a session on its Mac once it connects, when the viewer left while it was connecting", async () => {
    const { calls, link, links, method } = setup();
    link.close();
    expect(links.size).toBe(0);
    expect(method("close")).toEqual([]);
    calls[0]?.resolve({});
    await flush();
    expect(method("close").map((call) => call.input)).toEqual([{ sessionId: "s1" }]);
  });

  it("says why when the Mac cannot be reached, and tells the Mac to close in case it did connect", async () => {
    const { calls, ended, method } = setup();
    calls[0]?.reject(new Error("timed out"));
    await flush();
    expect(ended).toEqual([{ code: CloseCode.failed, reason: "MacBook Pro: timed out" }]);
    expect(method("close").map((call) => call.input)).toEqual([{ sessionId: "s1" }]);
  });

  it("closes on the Mac when the server ends it, and raises nothing after", async () => {
    const { calls, link, ended, data, links, method } = setup();
    calls[0]?.resolve({});
    await flush();
    link.close();
    link.close();
    links.data("host_laptop", { sessionId: "s1", seq: 0, data: "AAAA" });
    expect(method("close")).toHaveLength(1);
    expect(ended).toEqual([]);
    expect(data).toEqual([]);
  });
});
