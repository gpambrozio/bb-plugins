// @vitest-environment jsdom
/**
 * The page against a fake server, with noVNC and the relay's WebSocket
 * replaced: it points at System Settings when Screen Sharing is off, a
 * session asks for a ticket and opens the relay with it, the sign-in goes to
 * noVNC and nowhere else, View only reaches noVNC, and every way out —
 * Disconnect, leaving the page, the server ending it — closes the session and
 * says why.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloseCode, SESSIONS_CHANGED, type ScreenStatus } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { ScreenPanel, SessionsHeader } from "./screen-panel";

class FakeSocket extends EventTarget {
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close(): void {
    this.closed = true;
  }
  /** The relay closing it. */
  closeFromServer(code: number, reason = ""): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

class FakeRfb extends EventTarget {
  viewOnly = false;
  credentials: unknown[] = [];
  disconnects = 0;
  focused = 0;
  constructor(
    readonly target: HTMLElement,
    readonly socket: FakeSocket,
  ) {
    super();
  }
  emit(type: string, detail: unknown = {}): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  sendCredentials(credentials: unknown): void {
    this.credentials.push(credentials);
  }
  focus(): void {
    this.focused++;
  }
  disconnect(): void {
    this.disconnects++;
    this.emit("disconnect", { clean: true });
  }
}

const fakes = vi.hoisted(() => ({ sockets: [] as unknown[], rfbs: [] as unknown[] }));

vi.mock("./rfb", () => ({
  openRelaySocket: (url: string) => {
    const socket = new FakeSocket(url);
    fakes.sockets.push(socket);
    return socket;
  },
  createRfb: (target: HTMLElement, socket: FakeSocket) => {
    const rfb = new FakeRfb(target, socket);
    fakes.rfbs.push(rfb);
    return rfb;
  },
}));

const sockets = fakes.sockets as FakeSocket[];
const rfbs = fakes.rfbs as FakeRfb[];

beforeEach(() => {
  sockets.length = 0;
  rfbs.length = 0;
});

afterEach(() => cleanup());

const ready: ScreenStatus = {
  hostId: "host_mini",
  hostName: "MacMini",
  state: "ready",
  rfbVersion: "RFB 003.889",
  securityTypes: [30, 33, 36, 35],
  signInSupported: true,
  refusedReason: null,
};

function stubs(handlers: Partial<PluginRpcTestHandlers<RpcContract>>): PluginRpcTestHandlers<RpcContract> {
  return {
    sessions: () => ({ sessions: [] }),
    openSession: () => ({ token: "tkt", expiresAt: Date.now() + 30_000 }),
    ...handlers,
  } as PluginRpcTestHandlers<RpcContract>;
}

function renderPanel(handlers: Partial<PluginRpcTestHandlers<RpcContract>> = {}) {
  return renderSlot<PluginNavPanelProps, RpcContract>({ component: ScreenPanel }, { subPath: "" }, {
    rpc: stubs({ status: () => ready, ...handlers }),
  });
}

/** The Connect buttons: the toolbar's, then the one under the page's text. */
async function connectButtons(): Promise<{ toolbar: HTMLButtonElement; body: HTMLButtonElement }> {
  const [toolbar, body, ...rest] = (await screen.findAllByRole("button", { name: "Connect" })) as HTMLButtonElement[];
  expect(rest).toEqual([]);
  if (toolbar === undefined || body === undefined) throw new Error("expected two Connect buttons");
  return { toolbar, body };
}

async function connect(which: "toolbar" | "body" = "body") {
  fireEvent.click((await connectButtons())[which]);
  await waitFor(() => expect(rfbs).toHaveLength(1));
  return rfbs[0] as FakeRfb;
}

describe("the Screen Sharing page", () => {
  it("sends the user to System Settings when Screen Sharing is off, and checks again", async () => {
    let calls = 0;
    const view = renderPanel({
      status: () => {
        calls++;
        return calls === 1 ? { ...ready, state: "off", rfbVersion: null, securityTypes: [] } : ready;
      },
    });
    expect(await screen.findByText("Screen Sharing is off on MacMini")).toBeTruthy();
    expect(screen.getByText("System Settings → General → Sharing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await connectButtons();
    expect(view.rpcCalls.filter((call) => call.method === "status")).toHaveLength(2);
  });

  it("will not connect from a page the browser does not treat as secure", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      renderPanel();
      expect(await screen.findByText(/plain http:\/\/ address/)).toBeTruthy();
      const { toolbar, body } = await connectButtons();
      expect(toolbar.disabled).toBe(true);
      expect(body.disabled).toBe(true);
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, "isSecureContext");
      else Object.defineProperty(window, "isSecureContext", original);
    }
  });

  it("says when Screen Sharing is turning connections away", async () => {
    renderPanel({
      status: () => ({ ...ready, state: "refused", securityTypes: [], signInSupported: false, refusedReason: "Too many authentication failures" }),
    });
    expect(await screen.findByText("Screen Sharing on MacMini is turning connections away")).toBeTruthy();
    expect(screen.getByText("“Too many authentication failures”")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("says when the bb server is not on a Mac", async () => {
    renderPanel({ status: () => ({ ...ready, state: "unsupported", rfbVersion: null, securityTypes: [] }) });
    expect(await screen.findByText("macOS only")).toBeTruthy();
  });

  it("opens the relay with a fresh ticket, signs in through noVNC only, and shows the screen", async () => {
    const log = vi.spyOn(console, "log");
    const info = vi.spyOn(console, "info");
    const view = renderPanel();
    const rfb = await connect();

    expect(view.rpcCalls.find((call) => call.method === "openSession")?.input).toEqual({ hostId: "host_mini" });
    const url = new URL(rfb.socket.url);
    expect(url.pathname).toBe("/api/v1/plugins/screen-sharing/http/vnc");
    expect(url.protocol).toBe(window.location.protocol === "https:" ? "wss:" : "ws:");
    expect(url.host).toBe(window.location.host);
    expect(url.searchParams.get("host")).toBe("host_mini");
    expect(url.searchParams.get("token")).toBe("tkt");
    expect(screen.getByText("Connecting to MacMini…")).toBeTruthy();

    act(() => rfb.emit("credentialsrequired", { types: ["username", "password"] }));
    fireEvent.change(screen.getByLabelText("User name"), { target: { value: "captain" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(rfb.credentials).toEqual([{ username: "captain", password: "hunter2" }]);
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByText("Signing in…")).toBeTruthy();
    expect(JSON.stringify(view.rpcCalls)).not.toContain("hunter2");
    for (const spy of [log, info]) expect(JSON.stringify(spy.mock.calls)).not.toContain("hunter2");

    act(() => rfb.emit("connect"));
    expect(screen.queryByText("Signing in…")).toBeNull();
    expect(rfb.focused).toBe(1);
    expect(rfb.target).toBe(screen.getByTestId("vnc-screen"));
  });

  it("connects from the button under the page's text and from the toolbar alike", async () => {
    const view = renderPanel();
    const { body } = await connectButtons();
    expect(body.closest("div")?.textContent).toContain("A session closes when you leave this page");
    const fromBody = await connect("body");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(fromBody.disconnects).toBe(1);

    rfbs.length = 0;
    const fromToolbar = await connect("toolbar");
    expect(fromToolbar.socket.url).toContain("host=host_mini");
    expect(view.rpcCalls.filter((call) => call.method === "openSession")).toHaveLength(2);
    // While a session is open there is only the toolbar's Disconnect.
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("hands View only to noVNC, before and during a session", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "View only" }));
    const rfb = await connect();
    expect(rfb.viewOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "View only" }));
    expect(rfb.viewOnly).toBe(false);
    expect(screen.getByRole("button", { name: "View only" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("disconnects on Disconnect", async () => {
    renderPanel();
    const rfb = await connect();
    act(() => rfb.emit("connect"));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(rfb.disconnects).toBe(1);
    expect(await screen.findByText("Disconnected.")).toBeTruthy();
    await connectButtons();
  });

  it("disconnects when the page goes away", async () => {
    const view = renderPanel();
    const rfb = await connect();
    view.unmount();
    expect(rfb.disconnects).toBe(1);
  });

  it("never opens a socket when the page goes away before the ticket arrives", async () => {
    let release: (value: { token: string; expiresAt: number }) => void = () => {};
    const view = renderPanel({ openSession: () => new Promise((resolve) => (release = resolve)) });
    fireEvent.click((await connectButtons()).body);
    view.unmount();
    release({ token: "late", expiresAt: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toEqual([]);
  });

  it("ends a session after 30 minutes without keyboard or mouse use, and not before", async () => {
    renderPanel();
    const rfb = await connect();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      act(() => rfb.emit("connect"));
      const minutes = (count: number) => act(() => vi.advanceTimersByTime(count * 60_000));
      minutes(29);
      fireEvent.pointerMove(screen.getByTestId("vnc-screen"));
      minutes(29);
      expect(rfb.disconnects).toBe(0);
      fireEvent.keyDown(screen.getByTestId("vnc-screen"), { key: "a" });
      minutes(29);
      expect(rfb.disconnects).toBe(0);
      minutes(2);
      expect(rfb.disconnects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByText("Closed after 30 minutes without keyboard or mouse use.")).toBeTruthy();
  });

  it("says why the server ended a session", async () => {
    renderPanel();
    const rfb = await connect();
    act(() => rfb.emit("connect"));
    act(() => {
      rfb.socket.closeFromServer(CloseCode.closedByUser, "closed from bb");
      rfb.emit("disconnect", { clean: false });
    });
    expect(await screen.findByText("Closed from bb with Close all.")).toBeTruthy();
  });

  it("says when macOS refused the sign-in", async () => {
    renderPanel();
    const rfb = await connect();
    act(() => {
      rfb.emit("securityfailure", { status: 1, reason: "Authentication failed" });
      rfb.socket.closeFromServer(CloseCode.normal, "Screen Sharing closed the connection");
      rfb.emit("disconnect", { clean: false });
    });
    expect(await screen.findByText("Sign-in failed: Authentication failed.")).toBeTruthy();
  });

  it("says when no ticket was given", async () => {
    renderPanel({
      openSession: () => {
        throw new Error("only MacMini, the Mac running the bb server, can be shared in this version");
      },
    });
    fireEvent.click((await connectButtons()).body);
    expect(
      await screen.findByText("Could not start a session: only MacMini, the Mac running the bb server, can be shared in this version"),
    ).toBeTruthy();
    expect(sockets).toEqual([]);
  });
});

describe("the page's title bar", () => {
  it("shows open sessions from any device and closes them all", async () => {
    const view = renderSlot<PluginNavPanelProps, RpcContract>({ component: SessionsHeader }, { subPath: "" }, {
      rpc: stubs({ closeAll: () => ({ closed: 2 }) }),
    });
    expect(screen.queryByRole("button", { name: "Close all" })).toBeNull();
    const session = { id: "s", hostId: "host_mini", openedAt: 1, lastActivityAt: 1 };
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [session, { ...session, id: "t" }] });
    expect(await screen.findByText("2 sessions open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close all" }));
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "closeAll")).toBe(true));
  });
});
