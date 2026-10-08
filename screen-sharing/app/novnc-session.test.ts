// @vitest-environment jsdom
/**
 * The window's session store driving the real noVNC client (the pinned
 * @novnc/novnc, not a fake), with this test playing Apple's Screen Sharing
 * on the other end of the relay socket: RFB 003.889, ARD sign-in (type 30),
 * ServerInit. Only the socket is replaced. What it pins down, on noVNC's own
 * code paths:
 *
 * - the sign-in still completes, and afterwards the object noVNC keeps
 *   (`_rfbCredentials`) holds no user name or password — nor after a refused
 *   sign-in;
 * - taking the screen off the page releases a key and a mouse button held
 *   over it, as RFB key-up and button-up messages to the Mac;
 * - with no cursor shape from the Mac, the pointer over the screen is the
 *   ordinary arrow, not noVNC's invisible cursor or its dot.
 */
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Rfb } from "./rfb";

class FakeRelaySocket extends EventTarget {
  binaryType = "arraybuffer";
  protocol = "";
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  /** Every message the client sent, one entry per `send`. */
  sent: Uint8Array[] = [];

  send(data: ArrayBufferView | ArrayBuffer): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(new Uint8Array(bytes));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = Object.assign(new Event("close"), { code, reason, wasClean: true });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }

  /** The Mac sending bytes to the client. */
  serverSends(...parts: (number[] | Uint8Array | string)[]): void {
    const bytes = parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : [...part]));
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
}

const relay = vi.hoisted(() => ({ socket: null as unknown, rfbs: [] as unknown[] }));

vi.mock("./rfb", async (importActual) => {
  const actual = await importActual<typeof import("./rfb")>();
  return {
    ...actual,
    openRelaySocket: () => relay.socket,
    createRfb: (target: HTMLElement, socket: WebSocket) => {
      const rfb = actual.createRfb(target, socket);
      relay.rfbs.push(rfb);
      return rfb;
    },
  };
});

const { screenSession } = await import("./session-store");

/** A 2D context that accepts every call: noVNC draws, nothing here looks. */
function fakeContext(): CanvasRenderingContext2D {
  const imageData = (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height });
  const known: Record<string, unknown> = {
    createImageData: imageData,
    getImageData: (_x: number, _y: number, width: number, height: number) => imageData(width, height),
  };
  return new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
    set: (target, prop: string, value) => {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => fakeContext()) as unknown as HTMLCanvasElement["getContext"];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // noVNC builds cursor images with ImageData, which jsdom lacks without a canvas package.
  globalThis.ImageData ??= class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  } as unknown as typeof ImageData;
  // noVNC's touch-style cursor asks what is under the pointer; jsdom has no layout to say.
  document.elementFromPoint ??= () => null;
  // noVNC's ARD sign-in encrypts with WebCrypto.
  Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
});

let socket: FakeRelaySocket;
let container: HTMLDivElement;

beforeEach(() => {
  socket = new FakeRelaySocket();
  relay.socket = socket;
  relay.rfbs.length = 0;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  screenSession.detach();
  screenSession.reset();
  container.remove();
});

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function sentAfter(mark: number): Uint8Array[] {
  return socket.sent.slice(mark);
}

function rfbInstance(): Rfb {
  const rfb = relay.rfbs[0] as Rfb | undefined;
  if (rfb === undefined) throw new Error("no RFB client yet");
  return rfb;
}

/** What noVNC holds as the sign-in it was given. */
function heldCredentials(): Record<string, unknown> {
  return (rfbInstance() as unknown as { _rfbCredentials: Record<string, unknown> })._rfbCredentials;
}

/** Connects, plays Apple's side up to the sign-in prompt, and signs in. */
async function signIn(): Promise<void> {
  screenSession.attach(container);
  screenSession.connect({ openSession: async () => ({ token: "t" }), hostId: "host_mini", hostName: "MacMini" });
  await until(() => relay.rfbs.length === 1, "the RFB client");

  socket.serverSends("RFB 003.889\n");
  await until(() => socket.sent.length >= 1, "the client's version");
  expect(Buffer.from(socket.sent[0] ?? []).toString("latin1")).toBe("RFB 003.008\n");

  socket.serverSends([1, 30]);
  await until(() => screenSession.getSnapshot().stage.kind === "credentials", "the sign-in prompt");
  // ARD: generator, key length, prime, the server's public key.
  const keyLength = 16;
  socket.serverSends([0, 2], u16(keyLength), new Array(keyLength).fill(0).map((_, i) => (i === 0 ? 0xc3 : 0x5b + i)), new Array(keyLength).fill(7));

  const before = socket.sent.length;
  screenSession.sendCredentials({ username: "captain", password: "hunter2" });
  await until(() => sentAfter(before).some((message) => message.length >= 128 + keyLength), "the encrypted ARD sign-in");
}

/** Apple accepting the sign-in, then describing an 8×8 screen. */
async function acceptAndInit(): Promise<void> {
  socket.serverSends(u32(0));
  await until(() => socket.sent.at(-1)?.length === 1, "ClientInit");
  socket.serverSends(u16(8), u16(8), [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0], u32(4), "Mini");
  await until(() => screenSession.getSnapshot().stage.kind === "connected", "the connection");
}

describe("the session store with real noVNC", () => {
  it("signs in, then leaves no user name or password in noVNC's hands", async () => {
    await signIn();
    // Mid-sign-in noVNC still needs them: it re-reads them when its ARD step resumes.
    await acceptAndInit();
    const held = heldCredentials();
    expect(held.username).toBeUndefined();
    expect(held.password).toBeUndefined();
    expect(JSON.stringify(held)).not.toContain("hunter2");
  });

  it("forgets the sign-in when macOS refuses it", async () => {
    await signIn();
    const reason = "Authentication failed";
    socket.serverSends(u32(1), u32(reason.length), reason);
    await until(() => screenSession.getSnapshot().stage.kind === "idle", "the session to end");
    expect(screenSession.getSnapshot().ended).toBe("Sign-in failed: Authentication failed.");
    expect(heldCredentials().password).toBeUndefined();
    expect(heldCredentials().username).toBeUndefined();
  });

  it("releases a key and a mouse button held over the screen when the screen leaves the page", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");

    const beforeDown = socket.sent.length;
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1, clientX: 3, clientY: 4, bubbles: true, cancelable: true }));
    const down = sentAfter(beforeDown);
    expect(down.some((m) => m[0] === 4 && m[1] === 1 && m[7] === 0xe1)).toBe(true); // KeyEvent down, Shift_L
    expect(down.some((m) => m[0] === 5 && m[1] === 1)).toBe(true); // PointerEvent, left button down

    const beforeDetach = socket.sent.length;
    screenSession.detach();
    const released = sentAfter(beforeDetach);
    expect(released.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 0xe1)).toBe(true); // KeyEvent up, Shift_L
    expect(released.some((m) => m[0] === 5 && m[1] === 0)).toBe(true); // PointerEvent, no buttons
    expect(screenSession.getSnapshot().stage.kind).toBe("connected");

    // Away from the page the screen takes no input; back on it, it does again.
    const whileAway = socket.sent.length;
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
    expect(sentAfter(whileAway).some((m) => m[0] === 4)).toBe(false);
    screenSession.attach(container);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
    expect(sentAfter(whileAway).some((m) => m[0] === 4 && m[1] === 1)).toBe(true);
  });

  it("shows the ordinary arrow over the screen when the Mac sends no cursor", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");
    expect(canvas.style.cursor).toBe("none");
    expect(getComputedStyle(canvas).cursor).toBe("default");
    // And noVNC has no cursor image of its own to put there. With showDotCursor it would hold its 3×3
    // dot, which a desktop browser turns into a url() cursor — replacing `cursor: none`, so the arrow
    // rule never matches. (jsdom takes no url() cursors, so noVNC draws on a separate canvas here.)
    const cursorCanvas = (rfbInstance() as unknown as { _cursor: { _canvas: HTMLCanvasElement } })._cursor._canvas;
    expect(cursorCanvas.width).toBe(0);
  });
});
