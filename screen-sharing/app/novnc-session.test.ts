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
 * - taking the screen off the page, or turning View only on, releases a key
 *   and a mouse button held over it — a touch drag or long press included —
 *   as RFB key-up and button-up messages to the Mac;
 * - a held button leaves no noVNC pointer capture (its full-window overlay)
 *   over bb once the screen leaves the page or the session ends;
 * - with no cursor shape from the Mac, the pointer over the screen is the
 *   ordinary arrow, not noVNC's invisible cursor or its dot; a shape the Mac
 *   does send, an empty one included, is left as sent.
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

const { screenSessions } = await import("./session-store");
const screenSession = screenSessions.for("host_mini");

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

/** noVNC's pointer-capture overlay, when it has made one. */
function captureOverlay(): HTMLElement | null {
  return document.getElementById("noVNC_mouse_capture_elem");
}

function capturedElement(): Element | null | undefined {
  return (document as Document & { captureElement?: Element | null }).captureElement;
}

/** A touch event as noVNC's GestureHandler reads it: one finger, by `changedTouches`. */
function touch(type: "touchstart" | "touchmove" | "touchend", clientX: number, clientY: number): Event {
  const point = { identifier: 1, clientX, clientY };
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    changedTouches: [point],
    touches: type === "touchend" ? [] : [point],
  });
}

/** A FramebufferUpdate holding one Cursor pseudo-encoding rectangle (-239). */
function cursorUpdate(width: number, height: number): number[] {
  const pixels = new Array(width * height * 4).fill(0x80);
  const mask = new Array(Math.ceil(width / 8) * height).fill(0xff);
  return [0, 0, ...u16(1), ...u16(0), ...u16(0), ...u16(width), ...u16(height), ...u32(-239 >>> 0), ...pixels, ...mask];
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

  it("releases a key held when View only is turned on, and keeps View only across leaving and returning", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));

    const beforeViewOnly = socket.sent.length;
    screenSession.setViewOnly(true);
    expect(sentAfter(beforeViewOnly).some((m) => m[0] === 4 && m[1] === 0 && m[6] === 0xff && m[7] === 0xe3)).toBe(true); // Control_L up

    screenSession.detach();
    screenSession.attach(container);
    expect(screenSession.getSnapshot().viewOnly).toBe(true);
    expect(rfbInstance().viewOnly).toBe(true);
    const afterReturn = socket.sent.length;
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
    expect(sentAfter(afterReturn).some((m) => m[0] === 4)).toBe(false);
  });

  describe.each([
    { gesture: "drag", mask: 0x1 },
    { gesture: "long press", mask: 0x4 },
  ])("a touch $gesture in progress", ({ gesture, mask }) => {
    /** Starts the gesture on the screen; noVNC presses the Mac's button with no mouse event. */
    async function press(canvas: HTMLCanvasElement): Promise<void> {
      const before = socket.sent.length;
      if (gesture === "drag") {
        canvas.dispatchEvent(touch("touchstart", 10, 10));
        canvas.dispatchEvent(touch("touchmove", 120, 10));
      } else {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          canvas.dispatchEvent(touch("touchstart", 10, 10));
          vi.advanceTimersByTime(1100);
        } finally {
          vi.useRealTimers();
        }
      }
      expect(sentAfter(before).some((m) => m[0] === 5 && m[1] === mask)).toBe(true);
    }

    it.each(["the screen leaves the page", "View only is turned on"])("is released when %s", async (action) => {
      await signIn();
      await acceptAndInit();
      const canvas = container.querySelector("canvas");
      if (canvas === null) throw new Error("noVNC drew no canvas");
      await press(canvas);

      const before = socket.sent.length;
      if (action === "the screen leaves the page") screenSession.detach();
      else screenSession.setViewOnly(true);
      expect(sentAfter(before).some((m) => m[0] === 5 && m[1] === 0)).toBe(true); // button-up reached the Mac

      // Lifting the finger afterwards sends nothing more.
      const lifted = socket.sent.length;
      canvas.dispatchEvent(touch("touchend", 120, 10));
      expect(sentAfter(lifted).some((m) => m[0] === 5)).toBe(false);
    });
  });

  it("leaves no pointer capture over bb when the screen leaves the page with a button held", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1, clientX: 3, clientY: 4, bubbles: true, cancelable: true }));
    expect(capturedElement()).toBe(canvas);
    expect(captureOverlay()?.style.display).toBe("");

    const beforeDetach = socket.sent.length;
    screenSession.detach();
    expect(sentAfter(beforeDetach).some((m) => m[0] === 5 && m[1] === 0)).toBe(true); // button-up reached the Mac
    expect(capturedElement()).toBeNull();
    expect(captureOverlay()?.style.display).toBe("none");

    // Mouse use elsewhere in bb no longer reaches the detached screen.
    const elsewhere = socket.sent.length;
    const button = document.createElement("button");
    document.body.append(button);
    let clicked = 0;
    button.addEventListener("mouseup", () => clicked++);
    button.dispatchEvent(new MouseEvent("mousemove", { buttons: 1, clientX: 50, clientY: 50, bubbles: true }));
    button.dispatchEvent(new MouseEvent("mouseup", { buttons: 0, clientX: 50, clientY: 50, bubbles: true }));
    expect(clicked).toBe(1);
    expect(sentAfter(elsewhere).some((m) => m[0] === 5)).toBe(false);
    button.remove();
  });

  it("leaves no pointer capture over bb when the server ends a session with a button held", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1, clientX: 3, clientY: 4, bubbles: true, cancelable: true }));
    expect(capturedElement()).toBe(canvas);

    socket.close(4003, "closed from bb");
    await until(() => screenSession.getSnapshot().stage.kind === "idle", "the session to end");
    expect(screenSession.getSnapshot().ended).toBe("Closed from bb with Close all.");
    expect(capturedElement()).toBeNull();
    expect(captureOverlay()?.style.display).toBe("none");
  });

  it("leaves an empty cursor from the Mac hidden, as sent", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");
    expect(getComputedStyle(canvas).cursor).toBe("default");

    socket.serverSends(cursorUpdate(0, 0));
    await until(() => container.querySelector("[data-remote-cursor]") !== null, "the cursor update");
    expect(canvas.style.cursor).toBe("none");
    expect(getComputedStyle(canvas).cursor).toBe("none");
  });

  it("leaves a cursor shape from the Mac to noVNC", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");

    socket.serverSends(cursorUpdate(2, 2));
    await until(() => container.querySelector("[data-remote-cursor]") !== null, "the cursor update");
    const cursorCanvas = (rfbInstance() as unknown as { _cursor: { _canvas: HTMLCanvasElement } })._cursor._canvas;
    expect(cursorCanvas.width).toBe(2);
    // jsdom takes no url() cursors, so noVNC draws the shape on its own canvas and keeps `none` here.
    expect(getComputedStyle(canvas).cursor).not.toBe("default");
  });

  it("starts each connection with no cursor from the Mac", async () => {
    await signIn();
    await acceptAndInit();
    socket.serverSends(cursorUpdate(0, 0));
    await until(() => container.querySelector("[data-remote-cursor]") !== null, "the cursor update");
    screenSession.disconnect();

    socket = new FakeRelaySocket();
    relay.socket = socket;
    relay.rfbs.length = 0;
    screenSession.detach();
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");
    expect(getComputedStyle(canvas).cursor).toBe("default");
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

/** The RFB KeyEvents the client sent after `mark`: [down, keysym]. */
function keyEventsAfter(mark: number): Array<[boolean, number]> {
  return sentAfter(mark)
    .filter((m) => m[0] === 4 && m.length === 8)
    .map((m) => [m[1] === 1, ((m[4] ?? 0) << 24) | ((m[5] ?? 0) << 16) | ((m[6] ?? 0) << 8) | (m[7] ?? 0)]);
}

const SUPER_L = 0xffeb;
const TAB = 0xff09;

describe("Send keys, with real noVNC", () => {
  it("presses a combination in order and releases it in reverse", async () => {
    await signIn();
    await acceptAndInit();
    const { KEY_COMBOS } = await import("./keys");
    const combo = (id: string) => {
      const found = KEY_COMBOS.find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`no combo ${id}`);
      return found;
    };

    let mark = socket.sent.length;
    screenSession.sendKeys(combo("cmd-tab"));
    expect(keyEventsAfter(mark)).toEqual([[true, SUPER_L], [true, TAB], [false, TAB], [false, SUPER_L]]);

    mark = socket.sent.length;
    screenSession.sendKeys(combo("force-quit"));
    expect(keyEventsAfter(mark)).toEqual([
      [true, 0xffe9],
      [true, SUPER_L],
      [true, 0xff1b],
      [false, 0xff1b],
      [false, SUPER_L],
      [false, 0xffe9],
    ]);
  });

  it("holds ⌘ for the app switcher, lets Tab step it, and releases ⌘ when asked", async () => {
    await signIn();
    await acceptAndInit();
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("noVNC drew no canvas");

    let mark = socket.sent.length;
    screenSession.holdCommandForAppSwitcher();
    expect(keyEventsAfter(mark)).toEqual([[true, SUPER_L], [true, TAB], [false, TAB]]);
    expect(screenSession.getSnapshot().commandHeld).toBe(true);

    mark = socket.sent.length;
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
    expect(keyEventsAfter(mark)).toEqual([[true, TAB], [false, TAB]]);

    mark = socket.sent.length;
    screenSession.releaseCommand();
    expect(keyEventsAfter(mark)).toEqual([[false, SUPER_L]]);
    expect(screenSession.getSnapshot().commandHeld).toBe(false);
  });

  it.each([
    ["the screen leaves the page", () => screenSession.detach()],
    ["View only is turned on", () => screenSession.setViewOnly(true)],
    ["the user disconnects", () => screenSession.disconnect()],
  ])("lets go of a held ⌘ when %s", async (_what, action) => {
    await signIn();
    await acceptAndInit();
    screenSession.holdCommandForAppSwitcher();
    const mark = socket.sent.length;
    action();
    expect(keyEventsAfter(mark)).toEqual([[false, SUPER_L]]);
    expect(screenSession.getSnapshot().commandHeld).toBe(false);
  });

  it("sends nothing while View only", async () => {
    await signIn();
    await acceptAndInit();
    const { KEY_COMBOS } = await import("./keys");
    screenSession.setViewOnly(true);
    const mark = socket.sent.length;
    for (const combo of KEY_COMBOS) screenSession.sendKeys(combo);
    screenSession.holdCommandForAppSwitcher();
    expect(keyEventsAfter(mark)).toEqual([]);
    expect(screenSession.getSnapshot().commandHeld).toBe(false);
  });
});

describe("Full screen", () => {
  let fullscreenElement: Element | null = null;
  const lock = vi.fn(async () => {});
  const unlock = vi.fn();
  const requestFullscreen = vi.fn(async function (this: Element) {
    fullscreenElement = this;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  const exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });

  beforeEach(() => {
    fullscreenElement = null;
    lock.mockClear();
    unlock.mockClear();
    requestFullscreen.mockClear();
    exitFullscreen.mockClear();
    Object.defineProperty(navigator, "keyboard", { value: { lock, unlock }, configurable: true });
    Object.defineProperty(document, "fullscreenElement", { get: () => fullscreenElement, configurable: true });
    Object.defineProperty(document, "exitFullscreen", { value: exitFullscreen, configurable: true });
    Element.prototype.requestFullscreen = requestFullscreen as unknown as Element["requestFullscreen"];
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "keyboard");
  });

  async function goFullScreen(): Promise<HTMLElement> {
    await signIn();
    await acceptAndInit();
    const page = document.createElement("div");
    document.body.append(page);
    await screenSession.setFullScreen(true, page);
    expect(requestFullscreen.mock.contexts).toEqual([page]);
    expect(lock).toHaveBeenCalledWith();
    expect(screenSession.getSnapshot().fullScreen).toBe(true);
    return page;
  }

  it("ends when the user leaves full screen (holding Esc, in Chromium)", async () => {
    await goFullScreen();
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(unlock).toHaveBeenCalled();
    expect(screenSession.getSnapshot().fullScreen).toBe(false);
  });

  it.each([
    ["the switch is turned off", () => void screenSession.setFullScreen(false)],
    ["View only is turned on", () => screenSession.setViewOnly(true)],
    ["the screen leaves the page", () => screenSession.detach()],
    ["the user disconnects", () => screenSession.disconnect()],
  ])("ends, leaving full screen, when %s", async (_what, action) => {
    await goFullScreen();
    action();
    expect(unlock).toHaveBeenCalled();
    expect(exitFullscreen).toHaveBeenCalled();
    expect(screenSession.getSnapshot().fullScreen).toBe(false);
  });

  it("ends when the server ends the session (Close all)", async () => {
    await goFullScreen();
    socket.close(4003, "closed from bb");
    await until(() => screenSession.getSnapshot().stage.kind === "idle", "the session to end");
    expect(unlock).toHaveBeenCalled();
    expect(exitFullscreen).toHaveBeenCalled();
    expect(screenSession.getSnapshot().fullScreen).toBe(false);
  });

  it("does nothing where the browser has no Keyboard Lock, or while View only", async () => {
    await signIn();
    await acceptAndInit();
    const page = document.createElement("div");
    screenSession.setViewOnly(true);
    await screenSession.setFullScreen(true, page);
    screenSession.setViewOnly(false);
    Reflect.deleteProperty(navigator, "keyboard");
    const { canGoFullScreen } = await import("./session-store");
    expect(canGoFullScreen()).toBe(false);
    await screenSession.setFullScreen(true, page);
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(screenSession.getSnapshot().fullScreen).toBe(false);
  });
});
