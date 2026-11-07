// Reads the ChatGPT sign-in that `codex login` keeps in ~/.codex/auth.json.
//
// Read-only, on purpose: this module never refreshes the token and never
// writes the file. Codex rotates its refresh token when it refreshes, so a
// second program refreshing the same file can sign Codex out. When the access
// token has expired, the user runs Codex again and Codex refreshes it.
//
// Nothing here logs or returns the token except as the one `accessToken`
// field, and no error message includes any part of it.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A token that expires this soon counts as expired: a session needs time to open. */
export const EXPIRY_MARGIN_MS = 60_000;

export type CodexLoginProblem = "missing" | "malformed" | "expired";

export class CodexLoginError extends Error {
  readonly problem: CodexLoginProblem;

  constructor(problem: CodexLoginProblem, message: string) {
    super(message);
    this.name = "CodexLoginError";
    this.problem = problem;
  }
}

export type CodexLogin = {
  accessToken: string;
  /** Epoch milliseconds, from the token's own `exp` claim. */
  expiresAt: number;
};

/** Where Codex keeps its login: `$CODEX_HOME/auth.json`, `~/.codex/auth.json` by default. */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim();
  return join(codexHome ? codexHome : join(homedir(), ".codex"), "auth.json");
}

const SIGN_IN_HINT = "Run `codex login` and choose Sign in with ChatGPT";

export async function readCodexLogin(path: string, now: number = Date.now()): Promise<CodexLogin> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CodexLoginError("missing", `No Codex login found at ${path}. ${SIGN_IN_HINT} on the machine running the bb server.`);
    }
    throw new CodexLoginError("malformed", `Could not read the Codex login at ${path} (${code ?? "unknown error"}). ${SIGN_IN_HINT}.`);
  }
  return parseCodexLogin(text, path, now);
}

export function parseCodexLogin(text: string, path: string, now: number): CodexLogin {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new CodexLoginError("malformed", `The Codex login at ${path} is not valid JSON. ${SIGN_IN_HINT}.`);
  }
  const tokens = isRecord(file) ? file.tokens : undefined;
  const accessToken = isRecord(tokens) ? tokens.access_token : undefined;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    // An API-key login (`auth_mode: "apikey"`) has no ChatGPT token either.
    throw new CodexLoginError("missing", `The Codex login at ${path} has no ChatGPT sign-in. ${SIGN_IN_HINT}.`);
  }
  const token = accessToken.trim();
  // The token goes into an HTTP header. Anything outside JWT syntax (a line
  // break, a space, a control character) would make Headers or WebSocket throw
  // an error that quotes the whole header, token included, so it stops here.
  if (!JWT_SYNTAX.test(token)) {
    throw new CodexLoginError("malformed", `The ChatGPT token in ${path} is not a well-formed token. ${SIGN_IN_HINT}.`);
  }
  const expiresAt = tokenExpiry(token);
  if (expiresAt === null) {
    throw new CodexLoginError("malformed", `The ChatGPT token in ${path} has no readable expiry. ${SIGN_IN_HINT}.`);
  }
  if (expiresAt - EXPIRY_MARGIN_MS <= now) {
    throw new CodexLoginError(
      "expired",
      `The ChatGPT sign-in in ${path} expired on ${new Date(expiresAt).toISOString()}. Run \`codex\` once to refresh it, or \`codex login\` to sign in again.`,
    );
  }
  return { accessToken: token, expiresAt };
}

/** Three base64url parts separated by dots; the signature may be empty. */
const JWT_SYNTAX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u;

/** The largest epoch milliseconds a Date can hold, either side of 1970. */
const MAX_DATE_MS = 8.64e15;

/** The `exp` claim of a JWT, in epoch milliseconds, or null when there is none to read or it is out of range. */
function tokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const exp = isRecord(claims) ? claims.exp : undefined;
  if (typeof exp !== "number") return null;
  const expiresAt = exp * 1000;
  return Number.isFinite(expiresAt) && Math.abs(expiresAt) <= MAX_DATE_MS ? expiresAt : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
