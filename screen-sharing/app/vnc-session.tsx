/**
 * One live session: a ticket from the server, a WebSocket to the relay, and
 * noVNC drawing the screen into a div. Mounted only while the user wants the
 * session; unmounting it — Disconnect, leaving the page, closing the window —
 * closes the socket, and the server drops its side with it.
 *
 * The sign-in macOS asks for is typed into a form here and handed straight to
 * noVNC; nothing keeps it, logs it or sends it anywhere else.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";

import type { RpcContract } from "../shared/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { endMessage, type SessionEnd } from "./end-message";
import { createRfb, openRelaySocket, type Rfb } from "./rfb";
import { relayUrl } from "./relay-url";

type CredentialType = "username" | "password" | "target";

type Stage =
  | { kind: "connecting" }
  | { kind: "credentials"; types: CredentialType[] }
  | { kind: "signing-in" }
  | { kind: "connected" };

const FIELD_LABELS: Record<CredentialType, string> = {
  username: "User name",
  password: "Password",
  target: "Target",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CredentialsForm({ hostName, types, onSubmit }: { hostName: string; types: CredentialType[]; onSubmit(values: Partial<Record<CredentialType, string>>): void }) {
  const [values, setValues] = useState<Partial<Record<CredentialType, string>>>({});

  function submit(event: FormEvent) {
    event.preventDefault();
    const entered = values;
    setValues({});
    onSubmit(entered);
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-lg" autoComplete="off">
      <div>
        <h2 className="text-base font-semibold">Sign in to {hostName}</h2>
        <p className="text-sm text-muted-foreground">A macOS user on that Mac. bb does not keep what you type here.</p>
      </div>
      {types.map((type, index) => (
        <label key={type} className="flex flex-col gap-1 text-sm">
          <span>{FIELD_LABELS[type]}</span>
          <Input
            type={type === "password" ? "password" : "text"}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus={index === 0}
            value={values[type] ?? ""}
            onChange={(event) => setValues((current) => ({ ...current, [type]: event.target.value }))}
          />
        </label>
      ))}
      <Button type="submit">Sign in</Button>
    </form>
  );
}

export interface VncSessionProps {
  hostId: string;
  hostName: string;
  viewOnly: boolean;
  /** The session is over, for the reason given; the page unmounts this. */
  onEnded(message: string): void;
}

export function VncSession({ hostId, hostName, viewOnly, onEnded }: VncSessionProps) {
  // Read through a ref: the session must not restart if the client object ever changes identity.
  const rpc = useRpc<RpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const screen = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<Rfb | null>(null);
  const viewOnlyRef = useRef(viewOnly);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const [stage, setStage] = useState<Stage>({ kind: "connecting" });

  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    if (rfbRef.current !== null) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let rfb: Rfb | null = null;
    const end: SessionEnd = { close: null, securityFailure: null, connected: false };

    function finish(message: string): void {
      if (disposed) return;
      disposed = true;
      rfbRef.current = null;
      onEndedRef.current(message);
    }

    rpcRef.current
      .call("openSession", { hostId })
      .then(({ token }) => {
        if (disposed || screen.current === null) return;
        const opened = openRelaySocket(relayUrl(window.location.origin, hostId, token));
        socket = opened;
        // Registered before noVNC's own handler, so it has run when noVNC reports the disconnect.
        opened.addEventListener("close", (event) => {
          end.close = { code: event.code, reason: event.reason };
        });
        const client = createRfb(screen.current, opened);
        rfb = client;
        rfbRef.current = client;
        client.viewOnly = viewOnlyRef.current;
        client.addEventListener("credentialsrequired", (event) => {
          if (!disposed) setStage({ kind: "credentials", types: event.detail.types });
        });
        client.addEventListener("securityfailure", (event) => {
          end.securityFailure = event.detail.reason ?? `macOS refused the sign-in (status ${event.detail.status})`;
        });
        client.addEventListener("connect", () => {
          end.connected = true;
          if (disposed) return;
          setStage({ kind: "connected" });
          client.focus({ preventScroll: true });
        });
        client.addEventListener("disconnect", () => finish(endMessage(end)));
      })
      .catch((error: unknown) => finish(`Could not start a session: ${errorText(error)}`));

    return () => {
      disposed = true;
      rfbRef.current = null;
      if (rfb !== null) rfb.disconnect();
      else socket?.close();
    };
  }, [hostId]);

  function signIn(values: Partial<Record<CredentialType, string>>): void {
    setStage({ kind: "signing-in" });
    rfbRef.current?.sendCredentials(values);
  }

  return (
    <div className="relative flex min-h-0 flex-1 bg-muted">
      <div ref={screen} data-testid="vnc-screen" className="min-h-0 flex-1 overflow-hidden" />
      {stage.kind === "connected" ? null : (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          {stage.kind === "credentials" ? (
            <CredentialsForm hostName={hostName} types={stage.types} onSubmit={signIn} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="Spinner" />
              {stage.kind === "connecting" ? `Connecting to ${hostName}…` : "Signing in…"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
