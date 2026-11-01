/**
 * The tab's line to bb's terminal socket: replay and resume without
 * duplicates, acknowledgement after drawing, reconnecting, and when to stop.
 * A scripted socket and a manual clock stand in for the browser.
 */
import { describe, expect, it } from "vitest";

import {
  ATTACH_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  INPUT_CHUNK_BYTES,
  RECONNECT_DELAYS_MS,
  TerminalConnection,
  decodeBase64,
  encodeBase64,
  parseMessage,
  splitUtf8,
  terminalSocketUrl,
  type Clock,
  type ConnectionStatus,
  type SocketLike,
} from "./connection";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly sinceSeq: number) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

class ManualClock implements Clock {
  time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; every: number | null; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, every: null, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  setInterval(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, every: ms, callback });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.every === null) this.timers.delete(id);
      else timer.at += timer.every;
      timer.callback();
    }
    this.time = end;
  }
}

const running = { status: "running", exitCode: null };
const chunk = (seq: number, text: string) => ({ type: "output", chunk: { seq, dataBase64: encodeBase64(new TextEncoder().encode(text)) } });

type Retained = readonly { seq: number; dataBase64: string }[] | null;

function setup(options: { drawLater?: boolean; retained?: (sinceSeq: number) => Promise<Retained> } = {}) {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  const written: string[] = [];
  const pendingDraws: (() => void)[] = [];
  const statuses: ConnectionStatus[] = [];
  const connection = new TerminalConnection({
    terminalId: "term_1",
    clock,
    openSocket: (_id, sinceSeq) => {
      const socket = new FakeSocket(sinceSeq);
      sockets.push(socket);
      return socket;
    },
    write: (bytes, drawn) => {
      written.push(new TextDecoder().decode(bytes));
      if (options.drawLater) pendingDraws.push(drawn);
      else drawn();
    },
    onStatus: (status) => statuses.push(status),
    ...(options.retained === undefined ? {} : { readRetained: options.retained }),
  });
  connection.connect();
  const socket = () => sockets.at(-1)!;
  return { clock, sockets, socket, written, pendingDraws, statuses, connection };
}

describe("TerminalConnection", () => {
  it("attaches from the start and writes the replay, then live output", () => {
    const { socket, written, statuses, connection } = setup();
    expect(socket().sinceSeq).toBe(0);
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 2, session: running });
    socket().receive(chunk(0, "$ "));
    socket().receive(chunk(1, "ls\r\n"));
    socket().receive(chunk(2, "file\r\n"));
    expect(written).toEqual(["$ ", "ls\r\n", "file\r\n"]);
    expect(statuses.at(-1)).toEqual({ state: "live", exitCode: null });
    expect(connection.current.state).toBe("live");
  });

  it("acknowledges each chunk only once it is drawn", () => {
    const { socket, pendingDraws } = setup({ drawLater: true });
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    socket().receive(chunk(0, "a"));
    socket().receive(chunk(1, "b"));
    expect(socket().sent.filter((m) => (m as { type: string }).type === "ack")).toEqual([]);
    pendingDraws[0]!();
    pendingDraws[1]!();
    expect(socket().sent.filter((m) => (m as { type: string }).type === "ack")).toEqual([
      { type: "ack", nextSeq: 1 },
      { type: "ack", nextSeq: 2 },
    ]);
  });

  it("never reports itself hidden", () => {
    const { socket } = setup();
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    expect(socket().sent.some((m) => (m as { type: string }).type === "visibility")).toBe(false);
  });

  it("resumes after a dropped socket where it stopped, dropping what it already wrote", () => {
    const { clock, sockets, socket, written, statuses } = setup();
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    socket().receive(chunk(0, "one"));
    socket().receive(chunk(1, "two"));
    socket().drop();
    expect(statuses.at(-1)?.state).toBe("offline");
    clock.advance(RECONNECT_DELAYS_MS[0]!);
    expect(sockets).toHaveLength(2);
    expect(socket().sinceSeq).toBe(2);
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 1, nextSeq: 3, session: running });
    socket().receive(chunk(1, "two"));
    socket().receive(chunk(2, "three"));
    expect(written).toEqual(["one", "two", "three"]);
    expect(statuses.at(-1)?.state).toBe("live");
  });

  it("carries on from where bb's replay starts when the oldest output is gone", () => {
    const { socket, written } = setup();
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 40, nextSeq: 42, session: running });
    socket().receive(chunk(40, "x"));
    socket().receive(chunk(39, "older"));
    socket().receive(chunk(41, "y"));
    expect(written).toEqual(["x", "y"]);
  });

  it("backs off between reconnects and starts over once attached", () => {
    const { clock, sockets, socket } = setup();
    socket().drop();
    clock.advance(RECONNECT_DELAYS_MS[0]!);
    socket().drop();
    clock.advance(RECONNECT_DELAYS_MS[1]! - 1);
    expect(sockets).toHaveLength(2);
    clock.advance(1);
    expect(sockets).toHaveLength(3);
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    socket().drop();
    clock.advance(RECONNECT_DELAYS_MS[0]!);
    expect(sockets).toHaveLength(4);
  });

  it("shows the machine offline while bb holds the shell for it", () => {
    const { socket, statuses } = setup();
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: { status: "disconnected", exitCode: null } });
    expect(statuses.at(-1)?.state).toBe("offline");
    socket().receive({ type: "session-updated", session: running });
    expect(statuses.at(-1)?.state).toBe("live");
  });

  it("stops for good when the shell exits", () => {
    const { clock, sockets, socket, statuses } = setup();
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    socket().receive({ type: "exited", session: { status: "exited", exitCode: 130 } });
    expect(statuses.at(-1)).toEqual({ state: "ended", exitCode: 130 });
    expect(socket().closed).not.toBeNull();
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  describe("a shell that has exited", () => {
    const exited = { status: "exited", exitCode: 2 };
    const kept = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => chunk(from + index, `line${from + index}\n`).chunk);

    it("draws the output bb kept for it when the tab attaches after it ended", async () => {
      const asked: number[] = [];
      const { socket, written, statuses } = setup({
        retained: async (sinceSeq) => {
          asked.push(sinceSeq);
          return [...kept(0, 2)].reverse();
        },
      });
      socket().open();
      // bb 0.48.1 attaching to an exited session: no replay, then exited.
      socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: exited });
      socket().receive({ type: "exited", session: exited });
      expect(statuses.at(-1)?.state).not.toBe("ended");
      await expect.poll(() => statuses.at(-1)).toEqual({ state: "ended", exitCode: 2 });
      expect(asked).toEqual([0]);
      expect(written).toEqual(["line0\n", "line1\n", "line2\n"]);
    });

    it("adds only what it had not drawn when the shell exits during the attach", async () => {
      const asked: number[] = [];
      const { socket, written, statuses } = setup({
        retained: async (sinceSeq) => {
          asked.push(sinceSeq);
          return kept(1, 4);
        },
      });
      socket().open();
      socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
      socket().receive(chunk(0, "line0\n"));
      socket().receive(chunk(1, "line1\n"));
      socket().receive({ type: "exited", session: exited });
      await expect.poll(() => statuses.at(-1)?.state).toBe("ended");
      expect(asked).toEqual([2]);
      expect(written).toEqual(["line0\n", "line1\n", "line2\n", "line3\n", "line4\n"]);
    });

    it("still says it ended when bb no longer has the output", async () => {
      const { socket, written, statuses } = setup({
        retained: async () => {
          throw new Error("terminal_output_unavailable");
        },
      });
      socket().open();
      socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: exited });
      await expect.poll(() => statuses.at(-1)).toEqual({ state: "ended", exitCode: 2 });
      expect(written).toEqual([]);
    });
  });

  it("stops for good when bb no longer has the session", () => {
    const { clock, sockets, socket, statuses } = setup();
    socket().open();
    socket().receive({ type: "error", code: "terminal_not_found", message: "Terminal session not found" });
    socket().drop();
    expect(statuses.at(-1)).toEqual({ state: "ended", exitCode: null });
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("tries again when bb could not attach, though the socket stays open and answers pings", () => {
    const { clock, sockets, socket, statuses } = setup();
    socket().open();
    // bb 0.48.1's failTerminalAttach: the client is forgotten, the socket is not closed.
    socket().receive({ type: "error", code: "terminal_attach_timeout", message: "Timed out attaching terminal session" });
    expect(socket().closed?.code).toBe(4001);
    expect(statuses.at(-1)?.state).toBe("offline");
    clock.advance(RECONNECT_DELAYS_MS[0]!);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sinceSeq).toBe(0);
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    socket().receive(chunk(0, "back"));
    expect(statuses.at(-1)?.state).toBe("live");
  });

  it("tries again when bb never answers the attach", () => {
    const { clock, sockets, socket } = setup();
    socket().open();
    for (let elapsed = 0; elapsed < ATTACH_TIMEOUT_MS; elapsed += HEARTBEAT_INTERVAL_MS / 3) {
      clock.advance(HEARTBEAT_INTERVAL_MS / 3);
      socket().receive({ type: "pong" });
    }
    expect(socket().closed?.code).toBe(4001);
    clock.advance(RECONNECT_DELAYS_MS[0]!);
    expect(sockets).toHaveLength(2);
  });

  it("keeps an attached socket through an error about one message", () => {
    const { clock, sockets, socket, statuses } = setup();
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    // Typing while the machine drops off: bb holds the shell and says so with session-updated.
    socket().receive({ type: "error", code: "host_disconnected", message: "Host is not connected" });
    clock.advance(ATTACH_TIMEOUT_MS * 2);
    expect(socket().closed).toBeNull();
    expect(sockets).toHaveLength(1);
    expect(statuses.at(-1)?.state).toBe("live");
  });

  it("queues typing while connecting and sends it, and the size, once open", () => {
    const { socket, connection } = setup();
    connection.sendInput("echo hi\r");
    connection.resize(120, 40);
    connection.resize(132, 43);
    expect(socket().sent).toEqual([]);
    socket().open();
    expect(socket().sent).toEqual([
      { type: "resize", cols: 132, rows: 43 },
      { type: "input", dataBase64: encodeBase64(new TextEncoder().encode("echo hi\r")) },
    ]);
  });

  it("resends the size after a reconnect, and only a changed size otherwise", () => {
    const { clock, socket, connection } = setup();
    socket().open();
    connection.resize(80, 24);
    connection.resize(80, 24);
    expect(socket().sent).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
    socket().drop();
    clock.advance(RECONNECT_DELAYS_MS[0]!);
    socket().open();
    expect(socket().sent).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });

  it("splits a large paste into messages bb accepts", () => {
    const { socket, connection } = setup();
    socket().open();
    connection.sendInput("x".repeat(INPUT_CHUNK_BYTES * 2 + 5));
    const inputs = socket().sent as { dataBase64: string }[];
    expect(inputs.map((m) => decodeBase64(m.dataBase64).byteLength)).toEqual([INPUT_CHUNK_BYTES, INPUT_CHUNK_BYTES, 5]);
  });

  it("pings, and drops a socket that stops answering", () => {
    const { clock, sockets, socket } = setup();
    socket().open();
    socket().receive({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: running });
    clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(socket().sent).toContainEqual({ type: "ping" });
    socket().receive({ type: "pong" });
    clock.advance(HEARTBEAT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS);
    expect(socket().closed?.code).toBe(4000);
    socket().drop();
    clock.advance(RECONNECT_DELAYS_MS[0]!);
    expect(sockets).toHaveLength(2);
  });

  it("closes the socket and stays closed once disposed", () => {
    const { clock, sockets, socket, connection } = setup();
    socket().open();
    connection.dispose();
    expect(socket().closed?.code).toBe(1000);
    connection.sendInput("ignored");
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(socket().sent).toEqual([]);
  });
});

describe("parseMessage", () => {
  it("ignores what it does not understand", () => {
    expect(parseMessage(42)).toBeNull();
    expect(parseMessage("not json")).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "output", chunk: { seq: -1, dataBase64: "" } }))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "attached", replayStartSeq: 0, nextSeq: 0, session: { status: "weird" } }))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "something-new" }))).toBeNull();
  });
});

describe("splitUtf8", () => {
  it("never splits a character", () => {
    const pieces = splitUtf8("aé€😀", 4);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(pieces.map((piece) => decoder.decode(piece))).toEqual(["aé", "€", "😀"]);
  });

  it("sends a character longer than the limit whole", () => {
    const pieces = splitUtf8("😀a", 2);
    expect(pieces.map((piece) => new TextDecoder().decode(piece))).toEqual(["😀", "a"]);
  });
});

describe("terminalSocketUrl", () => {
  it("uses the page's origin and its scheme", () => {
    expect(terminalSocketUrl({ protocol: "https:", host: "me.getbb.app" }, "term_1", 7)).toBe(
      "wss://me.getbb.app/ws/terminals/term_1?sinceSeq=7&outputAcks=1",
    );
    expect(terminalSocketUrl({ protocol: "http:", host: "127.0.0.1:3000" }, "a/b", 0)).toBe(
      "ws://127.0.0.1:3000/ws/terminals/a%2Fb?sinceSeq=0&outputAcks=1",
    );
  });
});
