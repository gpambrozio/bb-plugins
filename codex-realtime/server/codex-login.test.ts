import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { chatgptLogin, fakeToken, tempCodexHome } from "../testing/fake-login";
import { CodexLoginError, EXPIRY_MARGIN_MS, codexAuthPath, readCodexLogin } from "./codex-login";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const HOUR = 3_600_000;

const homes: Array<ReturnType<typeof tempCodexHome>> = [];
function home() {
  const made = tempCodexHome();
  homes.push(made);
  return made;
}
afterEach(() => homes.splice(0).forEach((made) => made.remove()));

async function problemOf(path: string, now = NOW) {
  const error = await readCodexLogin(path, now).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CodexLoginError);
  return error as CodexLoginError;
}

describe("codexAuthPath", () => {
  it("is ~/.codex/auth.json by default", () => {
    expect(codexAuthPath({})).toBe(join(homedir(), ".codex", "auth.json"));
  });

  it("follows CODEX_HOME, as Codex does", () => {
    expect(codexAuthPath({ CODEX_HOME: "/srv/codex" })).toBe("/srv/codex/auth.json");
    expect(codexAuthPath({ CODEX_HOME: "  " })).toBe(join(homedir(), ".codex", "auth.json"));
  });
});

describe("readCodexLogin", () => {
  it("returns the access token and its expiry", async () => {
    const made = home();
    const token = fakeToken(NOW + 48 * HOUR);
    made.write(chatgptLogin(token));
    await expect(readCodexLogin(made.authPath, NOW)).resolves.toEqual({
      accessToken: token,
      expiresAt: Math.floor((NOW + 48 * HOUR) / 1000) * 1000,
    });
  });

  it("calls a missing file a missing login and names codex login", async () => {
    const error = await problemOf(join(home().dir, "auth.json"));
    expect(error.problem).toBe("missing");
    expect(error.message).toContain("codex login");
  });

  it("calls an API-key login, with no ChatGPT token, a missing login", async () => {
    const made = home();
    made.write(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fake-key", tokens: null }));
    expect((await problemOf(made.authPath)).problem).toBe("missing");
  });

  it("calls a file that is not JSON malformed", async () => {
    const made = home();
    made.write("{ not json");
    const error = await problemOf(made.authPath);
    expect(error.problem).toBe("malformed");
    expect(error.message).toContain("codex login");
  });

  it("calls a token without a readable expiry malformed, and never quotes it", async () => {
    const made = home();
    made.write(chatgptLogin("opaque-fake-token-value"));
    const error = await problemOf(made.authPath);
    expect(error.problem).toBe("malformed");
    expect(error.message).not.toContain("opaque-fake-token-value");
  });

  it("calls a file it cannot read malformed", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const made = home();
    made.write(chatgptLogin(fakeToken(NOW + HOUR)));
    chmodSync(made.authPath, 0o000);
    expect((await problemOf(made.authPath)).problem).toBe("malformed");
  });

  it("calls an expired token expired, says how to refresh it, and never quotes it", async () => {
    const made = home();
    const token = fakeToken(NOW - HOUR);
    made.write(chatgptLogin(token));
    const error = await problemOf(made.authPath);
    expect(error.problem).toBe("expired");
    expect(error.message).toContain("codex login");
    for (const part of token.split(".")) expect(error.message).not.toContain(part);
  });

  it("calls a token about to expire expired", async () => {
    const made = home();
    made.write(chatgptLogin(fakeToken(NOW + EXPIRY_MARGIN_MS - 1000)));
    expect((await problemOf(made.authPath)).problem).toBe("expired");
  });

  it("refuses a token with an embedded line break, which a header cannot carry, and never quotes it", async () => {
    const made = home();
    const [header, payload, signature] = fakeToken(NOW + HOUR).split(".");
    for (const broken of [`${header}.${payload}.${signature.slice(0, 5)}\r\n${signature.slice(5)}`, `${header}.${payload}.${signature}\nX-Injected: yes`]) {
      made.write(chatgptLogin(broken));
      const error = await problemOf(made.authPath);
      expect(error.problem).toBe("malformed");
      expect(error.message).toContain("codex login");
      for (const part of [header, payload, signature, signature.slice(5)]) expect(error.message).not.toContain(part);
    }
  });

  it("refuses a token with spaces or control characters inside it", async () => {
    const made = home();
    const [header, payload, signature] = fakeToken(NOW + HOUR).split(".");
    for (const broken of [`${header}.${payload} .${signature}`, `${header}.${payload}.${signature}\u0000`, `${header}.${payload}.sig+nature`]) {
      made.write(chatgptLogin(broken));
      expect((await problemOf(made.authPath)).problem).toBe("malformed");
    }
  });

  it("calls an expiry outside what a date can hold malformed", async () => {
    const made = home();
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const exp of [1e20, -1e20]) {
      made.write(chatgptLogin(`${part({ alg: "none" })}.${part({ exp })}.fake-signature`));
      const error = await problemOf(made.authPath);
      expect(error.problem).toBe("malformed");
      expect(error.message).toContain("codex login");
    }
  });
});
