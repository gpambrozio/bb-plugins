/**
 * The Screen Sharing page: the Mac running the bb server, whether its Screen
 * Sharing answers, and — once the user presses Connect — its screen. The
 * session lives only while this page is on screen: leaving the page ends it.
 */
import { useCallback, useEffect, useState } from "react";
import { useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import { SESSION_LIMITS, type ScreenStatus } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCloseAll, usePageOpen, useSessions } from "./sessions";
import { VncSession } from "./vnc-session";

const SHARING_SETTINGS = "System Settings → General → Sharing";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useStatus() {
  const rpc = useRpc<RpcContract>();
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(() => {
    setChecking(true);
    rpc
      .call("status", {})
      .then((value) => {
        setStatus(value);
        setError(null);
      })
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setChecking(false));
  }, [rpc]);

  useEffect(check, [check]);
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
  const { status, error, checking, check } = useStatus();
  const [live, setLive] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);

  const onEnded = useCallback((message: string) => {
    setLive(false);
    setEnded(message);
  }, []);

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

  // macOS's sign-in needs WebCrypto, which browsers offer only to https pages and to the machine itself.
  const insecure = window.isSecureContext === false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{status.hostName}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={viewOnly}
          onClick={() => setViewOnly((value) => !value)}
        >
          <Icon name={viewOnly ? "EyeOff" : "Eye"} />
          View only
        </Button>
        {live ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onEnded("Disconnected.")}>
            Disconnect
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={insecure}
            onClick={() => {
              setEnded(null);
              setLive(true);
            }}
          >
            Connect
          </Button>
        )}
      </div>
      {live ? (
        <VncSession hostId={status.hostId} hostName={status.hostName} viewOnly={viewOnly} onEnded={onEnded} />
      ) : (
        <Centered title={`Connect to ${status.hostName}`}>
          {ended !== null ? <p className="font-medium text-foreground">{ended}</p> : null}
          {insecure ? (
            <p className="text-warning-text">
              This page was opened at a plain http:// address, where the browser blocks macOS’s sign-in. Open bb on
              this Mac or through your getbb.app address instead.
            </p>
          ) : null}
          <p>
            You see and control this Mac’s screen through bb, at home or through getbb.app. macOS asks for a user name and
            password every time; bb does not keep them.
          </p>
          {!status.signInSupported ? (
            <p className="text-warning-text">
              This Mac offers no sign-in method this viewer knows (security types {status.securityTypes.join(", ")}).
              Connecting will likely fail.
            </p>
          ) : null}
          <p>
            A session closes when you leave this page, after {SESSION_LIMITS.idleMinutes} minutes without activity, and
            after {SESSION_LIMITS.maxHours} hours.
          </p>
        </Centered>
      )}
    </div>
  );
}
