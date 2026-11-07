// Temporary Codex login files for tests. The tokens are made up: three
// base64url parts with an `exp` claim and a signature that signs nothing.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A JWT-shaped fake token that expires at `expiresAt` (epoch ms), tagged so tests can tell two apart. */
export function fakeToken(expiresAt: number, tag = "a"): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ exp: Math.floor(expiresAt / 1000), sub: `fake-${tag}` })}.fake-signature-${tag}`;
}

/** The shape `codex login` writes for a ChatGPT sign-in, with fake values. */
export function chatgptLogin(accessToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "fake-id-token", access_token: accessToken, refresh_token: "fake-refresh-token", account_id: "fake-account" },
    last_refresh: "2026-11-01T00:00:00Z",
  });
}

/** A scratch Codex home; `write` replaces auth.json, `remove` deletes the folder. */
export function tempCodexHome() {
  const dir = mkdtempSync(join(tmpdir(), "codex-realtime-test-"));
  const authPath = join(dir, "auth.json");
  return {
    dir,
    authPath,
    write: (text: string) => writeFileSync(authPath, text, { mode: 0o600 }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
