/**
 * The live screen on the page: the window's session (session-store.ts) shown
 * in place, with the sign-in form and the "Connecting…" notes over it.
 * Unmounting this — leaving the page — only puts the screen away; the session
 * keeps running until it is disconnected or ends on its own.
 *
 * The sign-in macOS asks for is typed into a form here and handed straight to
 * noVNC; nothing keeps it, logs it or sends it anywhere else.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { screenSession, type CredentialType, type ScreenSessionSnapshot } from "./session-store";

const FIELD_LABELS: Record<CredentialType, string> = {
  username: "User name",
  password: "Password",
  target: "Target",
};

export function useScreenSession(): ScreenSessionSnapshot {
  return useSyncExternalStore(screenSession.subscribe, screenSession.getSnapshot);
}

function CredentialsForm({ hostName, types }: { hostName: string; types: CredentialType[] }) {
  const [values, setValues] = useState<Partial<Record<CredentialType, string>>>({});

  function submit(event: FormEvent) {
    event.preventDefault();
    const entered = values;
    setValues({});
    screenSession.sendCredentials(entered);
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

/** Lends the session's screen element a place on the page while the page is open. */
function ScreenMount() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    screenSession.attach(container);
    return () => screenSession.detach();
  }, []);
  return <div ref={host} data-testid="vnc-screen" className="min-h-0 flex-1 overflow-hidden" />;
}

export function LiveScreen() {
  const session = useScreenSession();
  const { stage } = session;
  const hostName = session.hostName ?? "the Mac";
  return (
    <div className="relative flex min-h-0 flex-1 bg-muted">
      <ScreenMount />
      {stage.kind === "connected" || stage.kind === "idle" ? null : (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          {stage.kind === "credentials" ? (
            <CredentialsForm hostName={hostName} types={stage.types} />
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
