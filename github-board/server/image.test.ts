/**
 * The image fetch end to end: the token source answers a made-up token and
 * `fetch` is a stub that records every request, so nothing in this file leaves
 * the machine. The URLs are the shapes a comment's author can type that a
 * hand-rolled host check and the URL parser `fetch` uses read differently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchGitHubImage } from "./image";

const FAKE_TOKEN = "gho_test_not_a_real_token";

function token(): Promise<string> {
  return Promise.resolve(FAKE_TOKEN);
}

type Seen = { url: string; authorization: string | null };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function image(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** A `fetch` that answers from `route` and remembers what it was asked for. */
function stubFetch(route: (url: URL) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      // What `fetch` would really request: the WHATWG parse of the input.
      const url = new URL(input instanceof Request ? input.url : String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      seen.push({ url: url.href, authorization });
      return Promise.resolve(route(url));
    }),
  );
  return seen;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the image fetch never hands the token to a host that is not GitHub", () => {
  const smuggled = [
    ["a backslash before the GitHub suffix", "https://attacker.example\\.githubusercontent.com/x.png"],
    ["a backslash and userinfo", "https://attacker.example\\@.githubusercontent.com/x.png"],
    ["a backslash after a port", "https://attacker.example:8443\\.githubusercontent.com/x.png"],
    ["userinfo before a non-GitHub host", "https://github.com@attacker.example/x.png"],
    ["a fragment before the GitHub suffix", "https://attacker.example#.githubusercontent.com/x.png"],
  ] as const;

  it.each(smuggled)("refuses %s without a request", async (_name, raw) => {
    const seen = stubFetch(() => image());
    await expect(fetchGitHubImage(raw, token)).rejects.toThrow(/Only images hosted on GitHub/);
    expect(seen).toEqual([]);
  });

  it("does not send the token to a githubusercontent.com host, which never needs it", async () => {
    const seen = stubFetch(() => image());
    await fetchGitHubImage("https://user-images.githubusercontent.com/1/x.png", token);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBeNull();
  });

  it("sends the token to github.com, where a private repository's attachment needs it", async () => {
    const seen = stubFetch(() => image());
    const dataUrl = await fetchGitHubImage(
      "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000",
      token,
    );
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe(`token ${FAKE_TOKEN}`);
  });
});

describe("image redirects", () => {
  it("follows GitHub's redirect to signed storage without the token", async () => {
    const seen = stubFetch((url) =>
      url.hostname === "github.com"
        ? redirect(
            "https://github-production-user-asset-6210df.s3.amazonaws.com/1/x.png?X-Amz-Signature=abc",
          )
        : image(),
    );
    const dataUrl = await fetchGitHubImage(
      "https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111",
      token,
    );
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(seen.map((request) => new URL(request.url).hostname)).toEqual([
      "github.com",
      "github-production-user-asset-6210df.s3.amazonaws.com",
    ]);
    expect(seen[0]?.authorization).toBe(`token ${FAKE_TOKEN}`);
    expect(seen[1]?.authorization).toBeNull();
  });

  it("drops the token on a redirect that leaves github.com, even to another GitHub host", async () => {
    const seen = stubFetch((url) =>
      url.hostname === "github.com"
        ? redirect("https://raw.githubusercontent.com/o/r/main/x.png")
        : image(),
    );
    await fetchGitHubImage("https://github.com/o/r/raw/main/x.png", token);
    expect(seen.map((request) => request.authorization)).toEqual([`token ${FAKE_TOKEN}`, null]);
  });

  it("keeps the token on a redirect that stays on github.com", async () => {
    const seen = stubFetch((url) =>
      url.pathname.startsWith("/old/") ? redirect("https://github.com/new/x.png") : image(),
    );
    await fetchGitHubImage("https://github.com/old/x.png", token);
    expect(seen.map((request) => request.authorization)).toEqual([
      `token ${FAKE_TOKEN}`,
      `token ${FAKE_TOKEN}`,
    ]);
  });

  it("refuses a redirect to plain http", async () => {
    const seen = stubFetch((url) =>
      url.protocol === "https:" ? redirect("http://github.com/x.png") : image(),
    );
    await expect(fetchGitHubImage("https://github.com/x.png", token)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("gives up on a redirect loop", async () => {
    const seen = stubFetch(() => redirect("https://github.com/loop.png"));
    await expect(fetchGitHubImage("https://github.com/loop.png", token)).rejects.toThrow(
      /redirect/i,
    );
    expect(seen.length).toBeLessThanOrEqual(6);
  });
});

describe("image limits", () => {
  it("stops reading a body that runs past the cap, whatever its content-length said", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    stubFetch(
      () => new Response(endless, { status: 200, headers: { "content-type": "image/png" } }),
    );
    await expect(fetchGitHubImage("https://github.com/huge.png", token)).rejects.toThrow(
      /too large/,
    );
    // The cap is 4 MiB; reading stops within a chunk or two of it, not at 64.
    expect(pulled).toBeLessThan(8);
  });

  it("refuses an answer that is not an image", async () => {
    stubFetch(
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await expect(fetchGitHubImage("https://github.com/page.png", token)).rejects.toThrow(
      /Not an image/,
    );
  });

  it("gives up on a host that never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: unknown, init?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }),
      );
      const pending = fetchGitHubImage("https://github.com/slow.png", token);
      const settled = expect(pending).rejects.toThrow(/too long/);
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a token lookup that never answers, and gives up without fetching", async () => {
    vi.useFakeTimers();
    let aborted = 0;
    // What `runGh` does with its signal: kill the `gh auth token` child and fail.
    const stalledToken = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted += 1;
          reject(new Error("The operation was aborted"));
        });
      });
    try {
      const seen = stubFetch(() => image());
      const pending = fetchGitHubImage("https://github.com/stalled-token.png", stalledToken);
      const settled = expect(pending).rejects.toThrow(/too long/);
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      expect(aborted).toBe(1);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
