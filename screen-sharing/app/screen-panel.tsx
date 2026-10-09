/**
 * The Screen Sharing page: the Macs enrolled in this bb, whether each one's
 * Screen Sharing answers, and — once the user presses Connect — the picked
 * Mac's screen. Sessions belong to the window (session-store.ts), one per
 * Mac, not to this page: leaving the page or picking another Mac puts the
 * screen away, coming back shows the same live session.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import { SESSION_LIMITS, type HostEntry, type ScreenStatus } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCloseAll, usePageOpen, useSessions } from "./sessions";
import { KeysNotice, FullScreenButton, SendKeysMenu } from "./keys-toolbar";
import { screenSessions, type ScreenSessionStore } from "./session-store";
import { LiveScreen, useScreenSession } from "./vnc-session";

const SHARING_SETTINGS = "System Settings → General → Sharing";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the page knows about one Mac's Screen Sharing. */
interface HostCheck {
  status: ScreenStatus | null;
  error: string | null;
  checking: boolean;
}

const UNCHECKED: HostCheck = { status: null, error: null, checking: true };

/**
 * The enrolled machines, listed once when the page opens, and each one's
 * status, checked once then and again on request — never on its own: a check
 * that failed mid-session would swap the session for the not-ready view. Every
 * Mac is checked at once, so the server's own (instant) does not wait on a
 * laptop's round trip. Only each Mac's latest check counts.
 */
function useHosts() {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const latest = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, HostCheck>>({});

  const check = useCallback((hostId: string) => {
    const asked = (latest.current.get(hostId) ?? 0) + 1;
    latest.current.set(hostId, asked);
    const current = () => mounted.current && latest.current.get(hostId) === asked;
    setChecks((all) => ({ ...all, [hostId]: { ...(all[hostId] ?? UNCHECKED), checking: true } }));
    rpcRef.current
      .call("status", { hostId })
      .then((status) => {
        if (current()) setChecks((all) => ({ ...all, [hostId]: { status, error: null, checking: false } }));
      })
      .catch((caught: unknown) => {
        if (current()) setChecks((all) => ({ ...all, [hostId]: { ...(all[hostId] ?? UNCHECKED), error: errorText(caught), checking: false } }));
      });
  }, []);

  const list = useCallback(() => {
    setListError(null);
    rpcRef.current
      .call("hosts", {})
      .then(({ hosts: listed }) => {
        if (!mounted.current) return;
        setHosts(listed);
        for (const host of listed) check(host.id);
      })
      .catch((caught: unknown) => {
        if (mounted.current) setListError(errorText(caught));
      });
  }, [check]);

  useEffect(() => {
    mounted.current = true;
    list();
    // A page that goes away mid-check ignores the answers.
    return () => {
      mounted.current = false;
    };
  }, [list]);

  return { hosts, listError, checks, check, list };
}

/** The Macs with a live session in this window, read again whenever one starts or ends. */
function useLiveHere(): string[] {
  useSyncExternalStore(screenSessions.subscribe, screenSessions.getVersion);
  return screenSessions.liveHostIds();
}

function pickDefault(hosts: HostEntry[], liveHere: string[]): string | null {
  const ids = new Set(hosts.map((host) => host.id));
  const lastPicked = screenSessions.picked;
  if (lastPicked !== null && ids.has(lastPicked)) return lastPicked;
  const live = liveHere.find((id) => ids.has(id));
  if (live !== undefined) return live;
  return (hosts.find((host) => host.isServer) ?? hosts[0])?.id ?? null;
}

function Centered({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {title !== undefined ? <h2 className="text-base font-semibold">{title}</h2> : null}
      <div className="flex max-w-md flex-col items-center gap-3 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function CheckAgain({ checking, onCheck }: { checking: boolean; onCheck(): void }) {
  return (
    <Button type="button" variant="outline" size="sm" disabled={checking} onClick={onCheck}>
      {checking ? <Icon name="Spinner" /> : <Icon name="ArrowReloadHorizontal" />}
      Check again
    </Button>
  );
}

function NotReady({ status, checking, onCheck }: { status: ScreenStatus; checking: boolean; onCheck(): void }) {
  if (status.state === "unsupported") {
    return (
      <Centered title="Not a Mac">
        <p>
          {status.isServer ? "The bb server is not running on a Mac" : `${status.hostName} is not a Mac`}, so there is no macOS
          Screen Sharing to connect to.
        </p>
      </Centered>
    );
  }
  if (status.state === "offline") {
    return (
      <Centered title={`${status.hostName} is offline`}>
        <p>bb has no connection to it right now. Wake it, or open bb on it, then check again.</p>
        <CheckAgain checking={checking} onCheck={onCheck} />
      </Centered>
    );
  }
  if (status.state === "unreachable") {
    return (
      <Centered title={`Could not check Screen Sharing on ${status.hostName}`}>
        {status.unreachableReason !== null ? <p className="font-medium text-foreground">{status.unreachableReason}</p> : null}
        <p>bb is connected to it, but the check did not get an answer. Updating bb on that Mac may help.</p>
        <CheckAgain checking={checking} onCheck={onCheck} />
      </Centered>
    );
  }
  if (status.state === "refused") {
    return (
      <Centered title={`Screen Sharing on ${status.hostName} is turning connections away`}>
        {status.refusedReason !== null ? <p className="font-medium text-foreground">“{status.refusedReason}”</p> : null}
        <p>macOS does this for a while after too many failed sign-ins. Wait a few minutes, then check again.</p>
        <CheckAgain checking={checking} onCheck={onCheck} />
      </Centered>
    );
  }
  return (
    <Centered title={status.state === "off" ? `Screen Sharing is off on ${status.hostName}` : `${status.hostName} is not sharing its screen`}>
      <p>
        On {status.hostName}, open <span className="font-medium text-foreground">{SHARING_SETTINGS}</span> and turn on{" "}
        <span className="font-medium text-foreground">Screen Sharing</span>. Under its options, “Allow access for: Only these
        users” keeps it to the accounts you choose.
      </p>
      <p>macOS does not let an app or script turn it on for you.</p>
      <CheckAgain checking={checking} onCheck={onCheck} />
    </Centered>
  );
}

/** A Mac's state in a word or two, for its place in the picker. */
function pickerNote(host: HostEntry, check: HostCheck | undefined, live: boolean): { text: string; className: string } {
  if (live) return { text: "Live", className: "text-destructive" };
  // The latest check knows better than the list read when the page opened.
  const status = check?.status ?? null;
  if (status === null && !host.connected) return { text: "Offline", className: "text-muted-foreground" };
  if (status === null) {
    return check?.error != null ? { text: "Can't check", className: "text-warning-text" } : { text: "Checking…", className: "text-muted-foreground" };
  }
  switch (status.state) {
    case "ready":
      return { text: "On", className: "text-success" };
    case "off":
    case "not-listening":
      return { text: "Screen Sharing off", className: "text-muted-foreground" };
    case "refused":
      return { text: "Refusing", className: "text-warning-text" };
    case "unsupported":
      return { text: "Not a Mac", className: "text-muted-foreground" };
    case "offline":
      return { text: "Offline", className: "text-muted-foreground" };
    case "unreachable":
      return { text: "Can't check", className: "text-warning-text" };
  }
}

function HostPicker({
  hosts,
  checks,
  live,
  picked,
  onPick,
}: {
  hosts: HostEntry[];
  checks: Record<string, HostCheck>;
  live: Set<string>;
  picked: string;
  onPick(hostId: string): void;
}) {
  return (
    <div role="radiogroup" aria-label="Mac" className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
      {hosts.map((host) => {
        const note = pickerNote(host, checks[host.id], live.has(host.id));
        const selected = host.id === picked;
        return (
          <button
            key={host.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onPick(host.id)}
            className={`flex min-w-0 max-w-full flex-col items-start rounded-md border px-2.5 py-1 text-left text-sm ${
              selected ? "border-border bg-card shadow-sm" : "border-transparent hover:bg-state-hover"
            }`}
          >
            <span className="max-w-48 truncate font-medium">{host.name}</span>
            <span className={`text-xs ${note.className}`}>{note.text}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The title bar's right side: open sessions on any device, and Close all. */
export function SessionsHeader(_props: PluginNavPanelProps) {
  const sessions = useSessions();
  const { closeAll, closing } = useCloseAll();
  if (sessions.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <span className="size-2 rounded-full bg-destructive" aria-hidden />
        {sessions.length === 1 ? "1 session open" : `${sessions.length} sessions open`}
      </span>
      <Button type="button" size="sm" variant="outline" disabled={closing} onClick={closeAll}>
        Close all
      </Button>
    </div>
  );
}

/** One Mac: its status or its screen, with the session's toolbar. */
function HostScreen({ host, check, onCheck, store }: { host: HostEntry; check: HostCheck; onCheck(): void; store: ScreenSessionStore }) {
  const rpc = useRpc<RpcContract>();
  const session = useScreenSession(store);
  const { status, error, checking } = check;
  /** What "Full screen" puts in full screen: this Mac's screen and its toolbar. */
  const page = useRef<HTMLDivElement>(null);
  const live = session.stage.kind !== "idle";

  // A session still running from an earlier visit is shown whatever a new status check says.
  if (!live) {
    if (status === null) {
      return error !== null ? (
        <Centered title={`Could not check Screen Sharing on ${host.name}`}>
          <p>{error}</p>
          <CheckAgain checking={checking} onCheck={onCheck} />
        </Centered>
      ) : (
        <Centered>
          <p className="flex items-center gap-2">
            <Icon name="Spinner" />
            Checking Screen Sharing on {host.name}…
          </p>
        </Centered>
      );
    }
    if (status.state !== "ready") return <NotReady status={status} checking={checking} onCheck={onCheck} />;
  }

  const hostName = (live ? session.hostName : status?.hostName) ?? host.name;
  // macOS's sign-in needs WebCrypto, which browsers offer only to https pages and to the machine itself.
  const insecure = window.isSecureContext === false;

  /** Starts a session; the toolbar's Connect and the one under the page's text both do this. */
  function connect(): void {
    if (status === null || status.state !== "ready") return;
    store.connect({
      openSession: (hostId) => rpc.call("openSession", { hostId }),
      hostId: status.hostId,
      hostName: status.hostName,
    });
  }

  return (
    <div ref={page} className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{hostName}</span>
        <Button type="button" size="sm" variant="ghost" aria-pressed={session.viewOnly} onClick={() => store.setViewOnly(!session.viewOnly)}>
          <Icon name={session.viewOnly ? "EyeOff" : "Eye"} />
          View only
        </Button>
        {live ? (
          <>
            <FullScreenButton store={store} session={session} fullscreenTarget={page} />
            <SendKeysMenu store={store} session={session} />
            <Button type="button" size="sm" variant="outline" onClick={() => store.disconnect()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" disabled={insecure} onClick={connect}>
            Connect
          </Button>
        )}
      </div>
      {live ? <KeysNotice store={store} session={session} /> : null}
      {live ? (
        <LiveScreen store={store} />
      ) : (
        <Centered title={`Connect to ${hostName}`}>
          {session.ended !== null ? <p className="font-medium text-foreground">{session.ended}</p> : null}
          {insecure ? (
            <p className="text-warning-text">
              This page was opened at a plain http:// address, where the browser blocks macOS’s sign-in. Open bb on the Mac
              running the bb server or through your getbb.app address instead.
            </p>
          ) : null}
          <p>
            You see and control this Mac’s screen through bb, at home or through getbb.app. macOS asks for a user name and
            password each time you connect; bb does not keep them.
          </p>
          {status !== null && !status.isServer ? (
            <p>
              bb reaches {hostName} through its own connection to it, so expect about half a second between a key or click and
              the screen answering, and fewer screen updates a second than on the Mac running bb.
            </p>
          ) : null}
          {status !== null && !status.signInSupported ? (
            <p className="text-warning-text">
              This Mac offers no sign-in method this viewer knows (security types {status.securityTypes.join(", ")}).
              Connecting will likely fail.
            </p>
          ) : null}
          <p>
            A session keeps running in this bb window while you use other pages or Macs, and is here again, still signed in,
            when you come back. It ends when you press Disconnect or Close all, when you close this window, after{" "}
            {SESSION_LIMITS.idleMinutes} minutes without keyboard or mouse use, and after {SESSION_LIMITS.maxHours} hours.
          </p>
          <Button type="button" disabled={insecure} onClick={connect}>
            Connect
          </Button>
        </Centered>
      )}
    </div>
  );
}

export function ScreenPanel(_props: PluginNavPanelProps) {
  usePageOpen();
  const { hosts, listError, checks, check, list } = useHosts();
  const liveHere = useLiveHere();
  const sessions = useSessions();
  const [picked, setPicked] = useState<string | null>(null);

  if (hosts === null) {
    return listError !== null ? (
      <Centered title="Could not list the Macs">
        <p>{listError}</p>
        <Button type="button" variant="outline" size="sm" onClick={list}>
          <Icon name="ArrowReloadHorizontal" />
          Try again
        </Button>
      </Centered>
    ) : (
      <Centered>
        <p className="flex items-center gap-2">
          <Icon name="Spinner" />
          Looking for Macs…
        </p>
      </Centered>
    );
  }

  const current = (picked !== null && hosts.some((host) => host.id === picked) ? picked : null) ?? pickDefault(hosts, liveHere);
  const host = hosts.find((entry) => entry.id === current);
  if (host === undefined) {
    return (
      <Centered title="No machines">
        <p>bb has no machine enrolled yet.</p>
      </Centered>
    );
  }

  const live = new Set([...liveHere, ...sessions.map((session) => session.hostId)]);
  function pick(hostId: string): void {
    screenSessions.picked = hostId;
    setPicked(hostId);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {hosts.length > 1 ? <HostPicker hosts={hosts} checks={checks} live={live} picked={host.id} onPick={pick} /> : null}
      <HostScreen key={host.id} host={host} check={checks[host.id] ?? UNCHECKED} onCheck={() => check(host.id)} store={screenSessions.for(host.id)} />
    </div>
  );
}
