/**
 * Test support: a TCP server on a loopback port standing in for macOS Screen
 * Sharing. It records its connections and what they sent; `onConnection`
 * plays the Mac's side. No test touches the real port 5900.
 */
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

export interface FakeVnc {
  port: number;
  sockets: Socket[];
  received: Buffer[];
  closed: number;
  close(): Promise<void>;
}

export async function startFakeVnc(onConnection?: (socket: Socket) => void): Promise<FakeVnc> {
  const fake: FakeVnc = { port: 0, sockets: [], received: [], closed: 0, close: async () => {} };
  const server: Server = createServer((socket) => {
    fake.sockets.push(socket);
    socket.on("data", (chunk) => fake.received.push(chunk));
    socket.on("close", () => fake.closed++);
    socket.on("error", () => {});
    onConnection?.(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.close = () =>
    new Promise((resolve) => {
      for (const socket of fake.sockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const fake = await startFakeVnc();
  await fake.close();
  return fake.port;
}

export async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
