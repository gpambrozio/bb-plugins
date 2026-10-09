// @vitest-environment jsdom
/**
 * The page against a fake server, with noVNC and the relay's WebSocket
 * replaced: it points at System Settings when Screen Sharing is off, a
 * session asks for a ticket and opens the relay with it, the sign-in goes to
 * noVNC and nowhere else, View only reaches noVNC, leaving the page keeps the
 * session for when the user comes back, the pointer stays visible, and every
 * way out — Disconnect, no input, the server ending it — closes the session
 * and says why.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloseCode, SESSIONS_CHANGED, type HostEntry, type ScreenStatus } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { ScreenPanel, SessionsHeader } from "./screen-panel";
import { hostDirectory } from "./hosts";
import { screenSessions } from "./session-store";

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
  /** Keys sent with sendKey: [keysym, down]. */
  keys: Array<[number, boolean]> = [];
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
  sendKey(keysym: number, _code: string, down: boolean): void {
    if (!this.viewOnly) this.keys.push([keysym, down]);
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
  releaseRemoteButtons: () => {},
}));

const sockets = fakes.sockets as FakeSocket[];
const rfbs = fakes.rfbs as FakeRfb[];

beforeEach(() => {
  sockets.length = 0;
  rfbs.length = 0;
});

afterEach(() => {
  cleanup();
  // The session belongs to the window, so it outlives each test's page.
  screenSessions.reset();
  hostDirectory.reset();
});

const ready: ScreenStatus = {
  hostId: "host_mini",
  hostName: "MacMini",
  isServer: true,
  state: "ready",
  rfbVersion: "RFB 003.889",
  securityTypes: [30, 33, 36, 35],
  signInSupported: true,
  refusedReason: null,
  unreachableReason: null,
};

const mini: HostEntry = { id: "host_mini", name: "MacMini", connected: true, isServer: true };

function stubs(handlers: Partial<PluginRpcTestHandlers<RpcContract>>): PluginRpcTestHandlers<RpcContract> {
  return {
    hosts: () => ({ hosts: [mini] }),
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
    expect(await screen.findByText("Not a Mac")).toBeTruthy();
    expect(screen.getByText(/The bb server is not running on a Mac/)).toBeTruthy();
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
    expect(rfb.target.parentElement).toBe(screen.getByTestId("vnc-screen"));
  });

  it("connects from the button under the page's text and from the toolbar alike", async () => {
    const view = renderPanel();
    const { body } = await connectButtons();
    expect(body.closest("div")?.textContent).toContain("A session keeps running in this bb window");
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

  it("keeps the session when the user leaves the page, and shows the same one on return", async () => {
    const first = renderPanel();
    const rfb = await connect();
    act(() => rfb.emit("credentialsrequired", { types: ["username", "password"] }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    act(() => rfb.emit("connect"));
    first.unmount();

    expect(rfb.disconnects).toBe(0);
    expect(rfb.socket.closed).toBe(false);
    expect(rfb.target.isConnected).toBe(false);

    const second = renderPanel();
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(rfb.target.parentElement).toBe(screen.getByTestId("vnc-screen"));
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(rfbs).toHaveLength(1);
    expect(rfb.credentials).toHaveLength(1);
    expect(second.rpcCalls.some((call) => call.method === "openSession")).toBe(false);
    expect(rfb.focused).toBe(2);
  });

  it("never opens a socket when Disconnect comes before the ticket", async () => {
    let release: (value: { token: string; expiresAt: number }) => void = () => {};
    renderPanel({ openSession: () => new Promise((resolve) => (release = resolve)) });
    fireEvent.click((await connectButtons()).body);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    release({ token: "late", expiresAt: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toEqual([]);
    expect(await screen.findByText("Disconnected.")).toBeTruthy();
  });

  it("Close all cancels this window's session while it is still waiting for its ticket", async () => {
    let release: (value: { token: string; expiresAt: number }) => void = () => {};
    const view = renderSlot<PluginNavPanelProps, RpcContract>(
      {
        component: (props: PluginNavPanelProps) => (
          <>
            <SessionsHeader {...props} />
            <ScreenPanel {...props} />
          </>
        ),
      },
      { subPath: "" },
      {
        rpc: stubs({
          status: () => ready,
          openSession: () => new Promise((resolve) => (release = resolve)),
          closeAll: () => ({ closed: 1 }),
        }),
      },
    );
    fireEvent.click((await connectButtons()).body);
    const session = { id: "elsewhere", hostId: "host_mini", openedAt: 1, lastActivityAt: 1 };
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [session] });
    fireEvent.click(await screen.findByRole("button", { name: "Close all" }));
    release({ token: "late", expiresAt: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toEqual([]);
    expect(await screen.findByText("Closed from bb with Close all.")).toBeTruthy();
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "closeAll")).toBe(true));
    // What the server publishes once every session has ended.
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [] });
  });

  it("shows a pointer over the screen while macOS sends no cursor of its own", async () => {
    renderPanel();
    const rfb = await connect();
    const canvas = document.createElement("canvas");
    rfb.target.append(canvas);
    canvas.style.cursor = "none";
    expect(getComputedStyle(canvas).cursor).toBe("default");
    // A real remote cursor is left alone.
    canvas.style.cursor = "url(data:image/png;base64,AAAA) 1 1, default";
    expect(getComputedStyle(canvas).cursor).toContain("url(");
  });

  it("ends a session after 30 minutes without keyboard or mouse use, and not before", async () => {
    renderPanel();
    const rfb = await connect();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      act(() => rfb.emit("connect"));
      const minutes = (count: number) => act(() => vi.advanceTimersByTime(count * 60_000));
      minutes(29);
      fireEvent.pointerMove(rfb.target);
      minutes(29);
      expect(rfb.disconnects).toBe(0);
      fireEvent.keyDown(rfb.target, { key: "a" });
      minutes(29);
      expect(rfb.disconnects).toBe(0);
      minutes(2);
      expect(rfb.disconnects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByText("Closed after 30 minutes without keyboard or mouse use.")).toBeTruthy();
  });

  it("ends an unseen session after 30 minutes without input, and says so on return", async () => {
    const view = renderPanel();
    const rfb = await connect();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      act(() => rfb.emit("connect"));
      view.unmount();
      act(() => vi.advanceTimersByTime(29 * 60_000));
      expect(rfb.disconnects).toBe(0);
      act(() => vi.advanceTimersByTime(2 * 60_000));
      expect(rfb.disconnects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    renderPanel();
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
        throw new Error("MacMini is offline");
      },
    });
    fireEvent.click((await connectButtons()).body);
    expect(await screen.findByText("Could not start a session: MacMini is offline")).toBeTruthy();
    expect(sockets).toEqual([]);
  });
});

describe("the Mac picker, in the title bar", () => {
  const laptop: HostEntry = { id: "host_laptop", name: "MacBook Pro", connected: true, isServer: false };
  const doxbook: HostEntry = { id: "host_doxbook", name: "DoxBook", connected: true, isServer: false };
  const linux: HostEntry = { id: "host_linux", name: "buildbox", connected: true, isServer: false };
  const away: HostEntry = { id: "host_away", name: "Travel MacBook", connected: false, isServer: false };
  const statuses: Record<string, ScreenStatus> = {
    host_mini: ready,
    host_laptop: { ...ready, hostId: "host_laptop", hostName: "MacBook Pro", isServer: false },
    host_doxbook: { ...ready, hostId: "host_doxbook", hostName: "DoxBook", isServer: false, state: "off", rfbVersion: null, securityTypes: [] },
    host_linux: { ...ready, hostId: "host_linux", hostName: "buildbox", isServer: false, state: "unsupported", rfbVersion: null, securityTypes: [] },
    host_away: { ...ready, hostId: "host_away", hostName: "Travel MacBook", isServer: false, state: "offline", rfbVersion: null, securityTypes: [] },
  };

  /** The page as bb shows it: the title bar's right side above the body. */
  function renderWithTitleBar(handlers: Partial<PluginRpcTestHandlers<RpcContract>> = {}) {
    return renderSlot<PluginNavPanelProps, RpcContract>(
      {
        component: (props: PluginNavPanelProps) => (
          <>
            <div data-testid="title-bar">
              <SessionsHeader {...props} />
            </div>
            <ScreenPanel {...props} />
          </>
        ),
      },
      { subPath: "" },
      {
        rpc: stubs({
          hosts: () => ({ hosts: [mini, laptop, doxbook, linux, away] }),
          status: ({ hostId }) => statuses[hostId] as ScreenStatus,
          openSession: ({ hostId }) => ({ token: `tkt-${hostId}`, expiresAt: Date.now() + 30_000 }),
          ...handlers,
        }),
      },
    );
  }

  const picker = () => within(screen.getByTestId("title-bar")).getByRole("button", { name: /^Mac: / });

  async function openPicker(): Promise<HTMLElement> {
    fireEvent.pointerDown(picker(), { button: 0, ctrlKey: false, pointerType: "mouse" });
    return screen.findByRole("menu");
  }

  async function pick(name: RegExp): Promise<void> {
    const menu = await openPicker();
    fireEvent.click(within(menu).getByRole("menuitem", { name }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }

  /** The menu's entries, each as "<name> <state>". */
  async function entries(): Promise<string[]> {
    const menu = await openPicker();
    const listed = within(menu)
      .getAllByRole("menuitem")
      .map((item) => Array.from(item.querySelectorAll("span")).map((part) => part.textContent).filter((text) => text !== "").join(" "));
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    return listed;
  }

  it("sits in the title bar with the picked Mac and its state, and leaves the toolbar without a name", async () => {
    renderWithTitleBar();
    await waitFor(() => expect(picker().getAttribute("aria-label")).toBe("Mac: MacMini, On"));
    expect(picker().textContent).toContain("MacMini");
    await connectButtons();
    const toolbar = screen.getByRole("button", { name: "View only" }).parentElement as HTMLElement;
    expect(toolbar.textContent).not.toContain("MacMini");
  });

  it("lists every machine with whether its Screen Sharing is on", async () => {
    const view = renderWithTitleBar();
    await waitFor(() => expect(view.rpcCalls.filter((call) => call.method === "status")).toHaveLength(5));
    await waitFor(async () =>
      expect(await entries()).toEqual(["MacMini On", "MacBook Pro On", "DoxBook Screen Sharing off", "buildbox Not a Mac", "Travel MacBook Offline"]),
    );
    expect(view.rpcCalls.filter((call) => call.method === "status").map((call) => call.input)).toEqual(
      ["host_mini", "host_laptop", "host_doxbook", "host_linux", "host_away"].map((hostId) => ({ hostId })),
    );
  });

  it("shows the one machine there is, too", async () => {
    renderPanel();
    await connectButtons();
    renderSlot<PluginNavPanelProps, RpcContract>({ component: SessionsHeader }, { subPath: "" }, { rpc: stubs({}) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Mac: MacMini, On" })).toBeTruthy());
  });

  it("trusts a newer check over the list when a Mac comes online", async () => {
    renderWithTitleBar({
      hosts: () => ({ hosts: [mini, away] }),
      status: ({ hostId }) => (hostId === "host_away" ? { ...(statuses.host_laptop as ScreenStatus), hostId, hostName: "Travel MacBook" } : ready),
    });
    await waitFor(async () => expect(await entries()).toContain("Travel MacBook On"));
  });

  it("says where to turn Screen Sharing on, on the Mac picked", async () => {
    renderWithTitleBar();
    await connectButtons();
    await pick(/DoxBook/);
    expect(await screen.findByText("Screen Sharing is off on DoxBook")).toBeTruthy();
    expect(screen.getByText(/On DoxBook, open/)).toBeTruthy();
    expect(picker().getAttribute("aria-label")).toBe("Mac: DoxBook, Screen Sharing off");
    await pick(/Travel MacBook/);
    expect(await screen.findByText("Travel MacBook is offline")).toBeTruthy();
    await pick(/buildbox/);
    expect(await screen.findByText(/buildbox is not a Mac/)).toBeTruthy();
  });

  it("connects to the Mac picked, saying what to expect from one reached through bb", async () => {
    const view = renderWithTitleBar();
    await connectButtons();
    expect(screen.queryByText(/about half a second/)).toBeNull();
    await pick(/MacBook Pro/);
    expect(await screen.findByText(/about half a second between a key or click/)).toBeTruthy();
    const rfb = await connect();
    expect(view.rpcCalls.find((call) => call.method === "openSession")?.input).toEqual({ hostId: "host_laptop" });
    expect(new URL(rfb.socket.url).searchParams.get("host")).toBe("host_laptop");
    expect(new URL(rfb.socket.url).searchParams.get("token")).toBe("tkt-host_laptop");
    expect(screen.getByText("Connecting to MacBook Pro…")).toBeTruthy();
    await waitFor(() => expect(picker().getAttribute("aria-label")).toBe("Mac: MacBook Pro, Live"));
  });

  it("keeps sessions to several Macs at once, showing the one picked, and Close all ends them all", async () => {
    renderWithTitleBar({ closeAll: () => ({ closed: 2 }) });
    const onMini = await connect();
    act(() => onMini.emit("connect"));

    await pick(/MacBook Pro/);
    fireEvent.click((await connectButtons()).body);
    await waitFor(() => expect(rfbs).toHaveLength(2));
    const onLaptop = rfbs[1] as FakeRfb;
    act(() => onLaptop.emit("connect"));
    // The other session runs on, put away with its input suspended.
    expect(onMini.target.isConnected).toBe(false);
    expect(onMini.viewOnly).toBe(true);
    expect(onMini.disconnects).toBe(0);
    expect(onLaptop.target.parentElement).toBe(screen.getByTestId("vnc-screen"));
    expect(await entries()).toEqual(expect.arrayContaining(["MacMini Live", "MacBook Pro Live"]));

    await pick(/MacMini/);
    await waitFor(() => expect(onMini.target.parentElement).toBe(screen.getByTestId("vnc-screen")));
    expect(onMini.viewOnly).toBe(false);
    expect(onLaptop.viewOnly).toBe(true);
    expect(rfbs).toHaveLength(2);

    act(() => screenSessions.disconnectAll("Closed from bb with Close all."));
    expect(onMini.disconnects).toBe(1);
    expect(onLaptop.disconnects).toBe(1);
  });

  it("shows the Mac picked last when the page opens again", async () => {
    const first = renderWithTitleBar();
    await connectButtons();
    await pick(/MacBook Pro/);
    const rfb = await connect();
    act(() => rfb.emit("connect"));
    first.unmount();
    renderWithTitleBar();
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(picker().getAttribute("aria-label")).toBe("Mac: MacBook Pro, Live");
    expect(rfb.target.parentElement).toBe(screen.getByTestId("vnc-screen"));
  });

  it("says when bb could not list the machines, and tries again", async () => {
    let calls = 0;
    renderPanel({
      hosts: () => {
        calls++;
        if (calls === 1) throw new Error("server busy");
        return { hosts: [mini] };
      },
    });
    expect(await screen.findByText("server busy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await connectButtons();
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

describe("the page's keyboard controls", () => {
  async function connected(): Promise<FakeRfb> {
    renderPanel();
    const rfb = await connect();
    act(() => rfb.emit("connect"));
    return rfb;
  }

  it("sends a shortcut from the Send keys menu, and says Full screen needs another browser here", async () => {
    const rfb = await connected();
    expect((screen.getByRole("button", { name: "Full screen" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send keys" }));
    expect(screen.getByText(/can’t hand its own shortcuts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Spotlight/ }));
    expect(rfb.keys).toEqual([
      [0xffeb, true],
      [0x20, true],
      [0x20, false],
      [0xffeb, false],
    ]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("holds ⌘ for the app switcher until Release ⌘", async () => {
    const rfb = await connected();
    fireEvent.click(screen.getByRole("button", { name: "Send keys" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /app switcher/ }));
    expect(await screen.findByText(/⌘ is held down on MacMini/)).toBeTruthy();
    rfb.keys.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Release ⌘" }));
    expect(rfb.keys).toEqual([[0xffeb, false]]);
    expect(screen.queryByText(/⌘ is held down/)).toBeNull();
  });

  it("offers neither while View only", async () => {
    await connected();
    fireEvent.click(screen.getByRole("button", { name: "View only" }));
    expect((screen.getByRole("button", { name: "Send keys" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Full screen" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("puts the whole page in full screen with the keyboard locked, and says how to get out", async () => {
    let fullscreenElement: Element | null = null;
    const requestFullscreen = vi.fn(async function (this: Element) {
      fullscreenElement = this;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(navigator, "keyboard", { value: { lock: vi.fn(async () => {}), unlock: vi.fn() }, configurable: true });
    Object.defineProperty(document, "fullscreenElement", { get: () => fullscreenElement, configurable: true });
    Object.defineProperty(document, "exitFullscreen", {
      value: async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      },
      configurable: true,
    });
    const original = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = requestFullscreen as unknown as Element["requestFullscreen"];
    try {
      await connected();
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      expect(await screen.findByText(/Hold Esc to leave full screen/)).toBeTruthy();
      expect(screen.getByText(/⌘Tab, ⌘Space, ⌘` and Mission Control stay on this computer/)).toBeTruthy();
      const page = requestFullscreen.mock.contexts[0] as Element;
      expect(page.contains(screen.getByRole("button", { name: "Send keys" }))).toBe(true);
      expect(page.contains(screen.getByTestId("vnc-screen"))).toBe(true);
      expect(screen.getByRole("button", { name: "Full screen" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      Element.prototype.requestFullscreen = original;
      Reflect.deleteProperty(navigator, "keyboard");
    }
  });
});
