/**
 * The Screen Sharing page: the Mac running the bb server, whether its Screen
 * Sharing answers, and — once the user presses Connect — its screen. The
 * session belongs to the window (session-store.ts), not to this page: leaving
 * the page puts the screen away, coming back shows the same live session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import { SESSION_LIMITS, type ScreenStatus } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCloseAll, usePageOpen, useSessions } from "./sessions";
import { KeysNotice, FullScreenButton, SendKeysMenu } from "./keys-toolbar";
import { screenSession } from "./session-store";
import { LiveScreen, useScreenSession } from "./vnc-session";

const SHARING_SETTINGS = "System Settings → General → Sharing";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks once when the page opens and again on request, never on its own: a
 * check that failed mid-session would swap the session for the not-ready view.
 * Only the latest check's answer is used.
 */
function useStatus() {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const latest = useRef(0);
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(() => {
    const asked = ++latest.current;
    setChecking(true);
    rpcRef.current
      .call("status", {})
      .then((value) => {
        if (asked !== latest.current) return;
        setStatus(value);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (asked === latest.current) setError(errorText(caught));
      })
      .finally(() => {
        if (asked === latest.current) setChecking(false);
      });
  }, []);

  useEffect(() => {
    check();
    // A page that goes away mid-check ignores the answer.
    return () => {
      latest.current++;
    };
  }, [check]);
  return { status, error, checking, check };
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
      <Centered title="macOS only">
        <p>The bb server is not running on a Mac, so there is no macOS Screen Sharing to connect to.</p>
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

export function ScreenPanel(_props: PluginNavPanelProps) {
  usePageOpen();
  const rpc = useRpc<RpcContract>();
  const session = useScreenSession();
  const { status, error, checking, check } = useStatus();
  /** What "Full screen" puts in full screen: the whole page, toolbar included. */
  const page = useRef<HTMLDivElement>(null);
  const live = session.stage.kind !== "idle";

  // A session still running from an earlier visit is shown whatever a new status check says.
  if (!live) {
    if (status === null) {
      return error !== null ? (
        <Centered title="Could not check Screen Sharing">
          <p>{error}</p>
          <CheckAgain checking={checking} onCheck={check} />
        </Centered>
      ) : (
        <Centered>
          <p className="flex items-center gap-2">
            <Icon name="Spinner" />
            Checking Screen Sharing…
          </p>
        </Centered>
      );
    }
    if (status.state !== "ready") return <NotReady status={status} checking={checking} onCheck={check} />;
  }

  const hostName = (live ? session.hostName : status?.hostName) ?? "";
  // macOS's sign-in needs WebCrypto, which browsers offer only to https pages and to the machine itself.
  const insecure = window.isSecureContext === false;

  /** Starts a session; the toolbar's Connect and the one under the page's text both do this. */
  function connect(): void {
    if (status === null || status.state !== "ready") return;
    screenSession.connect({
      openSession: (hostId) => rpc.call("openSession", { hostId }),
      hostId: status.hostId,
      hostName: status.hostName,
    });
  }

  return (
    <div ref={page} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{hostName}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={session.viewOnly}
          onClick={() => screenSession.setViewOnly(!session.viewOnly)}
        >
          <Icon name={session.viewOnly ? "EyeOff" : "Eye"} />
          View only
        </Button>
        {live ? (
          <>
            <FullScreenButton session={session} fullscreenTarget={page} />
            <SendKeysMenu session={session} />
            <Button type="button" size="sm" variant="outline" onClick={() => screenSession.disconnect()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" disabled={insecure} onClick={connect}>
            Connect
          </Button>
        )}
      </div>
      {live ? <KeysNotice session={session} /> : null}
      {live ? (
        <LiveScreen />
      ) : (
        <Centered title={`Connect to ${hostName}`}>
          {session.ended !== null ? <p className="font-medium text-foreground">{session.ended}</p> : null}
          {insecure ? (
            <p className="text-warning-text">
              This page was opened at a plain http:// address, where the browser blocks macOS’s sign-in. Open bb on
              this Mac or through your getbb.app address instead.
            </p>
          ) : null}
          <p>
            You see and control this Mac’s screen through bb, at home or through getbb.app. macOS asks for a user name and
            password each time you connect; bb does not keep them.
          </p>
          {status !== null && !status.signInSupported ? (
            <p className="text-warning-text">
              This Mac offers no sign-in method this viewer knows (security types {status.securityTypes.join(", ")}).
              Connecting will likely fail.
            </p>
          ) : null}
          <p>
            A session keeps running in this bb window while you use other pages, and is here again, still signed in,
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
