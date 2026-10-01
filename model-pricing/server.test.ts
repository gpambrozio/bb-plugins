/**
 * The server entry through the SDK's fake host: a reload while a fetch is in
 * flight. The new instance loads before the old one is disposed, and after
 * dispose the old instance's `bb` handle is stale — so the old fetch must be
 * aborted, and nothing it answers may be written through that handle.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "./server";
import type { LoadOutputSchema } from "./shared/pricing";
import type { z } from "zod";

type Output = z.output<typeof LoadOutputSchema>;

const OPENROUTER_BODY = {
  data: [{ id: "z-ai/glm-5.3", name: "GLM 5.3", pricing: { prompt: "0.0000014", completion: "0.0000044" } }],
};

const live: Array<{ harness: { lifecycle: { dispose(): Promise<void> } } }> = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((host) => host.harness.lifecycle.dispose().catch(() => {})));
  vi.unstubAllGlobals();
});

describe("model-pricing server", () => {
  it("aborts a fetch left in flight by a reload, and the new instance fetches for itself", async () => {
    const signals: AbortSignal[] = [];
    // The first request hangs until aborted and then answers anyway, as a
    // response already on the wire would; every later one answers at once.
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      if (signal !== undefined) signals.push(signal);
      if (signals.length > 1) return Promise.resolve(Response.json(OPENROUTER_BODY));
      return new Promise<Response>((resolve) => {
        signal?.addEventListener("abort", () => resolve(Response.json(OPENROUTER_BODY)));
      });
    });

    const host = createFakePluginHost({ pluginId: "model-pricing" });
    await plugin(host.bb);
    live.push(host);
    const pending = host.harness.callRpc("load", { providers: ["openrouter"] });
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    const reloaded = await host.harness.lifecycle.reload(plugin);
    live.push(reloaded);

    expect(signals[0]?.aborted).toBe(true);
    // The old caller still gets an answer, and nothing it did reached the stale handle.
    expect(((await pending) as Output).rows).toHaveLength(1);
    const stale = [...host.harness.logEntries, ...reloaded.harness.logEntries].filter((entry) =>
      JSON.stringify(entry).includes("stale"),
    );
    expect(stale).toEqual([]);

    const fresh = (await reloaded.harness.callRpc("load", { providers: ["openrouter"] })) as Output;
    expect(fresh.rows.map((row) => row.modelId)).toEqual(["z-ai/glm-5.3"]);
    expect(fresh.sources[0]?.cached).toBe(false);
  });
});
