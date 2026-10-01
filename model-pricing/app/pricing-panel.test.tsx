// @vitest-environment jsdom
/**
 * The panel renders, asks the server for exactly the providers switched on,
 * and filters on the client without asking again. A throwing slot shows as a
 * "plugin crashed" chip in bb, so a render here is the cheapest check that it
 * does not throw.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { PriceRow, SourceStatus } from "../shared/pricing";
import { PROVIDERS } from "../shared/providers";

function row(overrides: Partial<PriceRow> = {}): PriceRow {
  return {
    providerId: "anthropic",
    modelId: "claude-opus-5",
    name: "Claude Opus 5",
    contextTokens: 1_000_000,
    outputTokens: 128_000,
    inputCost: 5,
    outputCost: 25,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    temperature: null,
    releaseDate: null,
    ...overrides,
  };
}

const ROWS = [
  row(),
  row({ providerId: "openai", modelId: "gpt-6", name: "GPT-6", inputCost: 1, outputCost: 4 }),
  row({ providerId: "openai", modelId: "gpt-6-mini", name: "GPT-6 mini", inputCost: 0.2, outputCost: 0.8, toolCall: false }),
];

function ok(id: string): SourceStatus {
  return { id, fetchedAt: Date.now(), cached: false, error: null };
}

/** The panel keeps its last answer at module scope; each test starts a fresh window. */
async function freshPanel() {
  vi.resetModules();
  return (await import("./pricing-panel")).PricingPanel;
}

let width = 1200;

beforeEach(() => {
  width = 1200;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the app", () => {
  // The harness does not capture palette commands, only slots.
  it("registers the page and the navigator overlay", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["pricing"]);
    expect(app.appOverlays).toHaveLength(1);
  });
});

describe("PricingPanel", () => {
  it("asks for the providers switched on, and draws their rows", async () => {
    const PricingPanel = await freshPanel();
    const slot = renderSlot<object, RpcContract>(
      { component: PricingPanel },
      {},
      {
        settings: { openrouter: false, fireworks: false },
        rpc: { load: () => ({ rows: ROWS, sources: [ok("models-dev")] }) },
      },
    );

    await screen.findByText("Claude Opus 5");
    expect(slot.rpcCalls).toHaveLength(1);
    expect(slot.rpcCalls[0]?.input).toEqual({ providers: ["anthropic", "openai", "ollama"], refresh: false });
    // Tool-call filter on by default: the model that says it cannot is hidden.
    expect(screen.queryByText("GPT-6 mini")).toBeNull();
    expect(screen.getByText("GPT-6")).toBeTruthy();
    // Only the enabled providers have a legend dot.
    expect(screen.getByRole("checkbox", { name: "Hide Anthropic models" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /OpenRouter/ })).toBeNull();
  });

  it("hides a provider from its legend dot without asking the server again", async () => {
    const PricingPanel = await freshPanel();
    const slot = renderSlot<object, RpcContract>(
      { component: PricingPanel },
      {},
      { rpc: { load: () => ({ rows: ROWS, sources: [ok("models-dev")] }) } },
    );
    await screen.findByText("Claude Opus 5");

    fireEvent.click(screen.getByRole("checkbox", { name: "Hide Anthropic models" }));
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Show Anthropic models" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.change(screen.getByRole("textbox", { name: "Search models and providers" }), { target: { value: "nothing" } });
    expect(screen.getByText("Nothing matches.")).toBeTruthy();
    expect(slot.rpcCalls).toHaveLength(1);
  });

  it("paints each provider in the variant for bb's mode", async () => {
    const anthropic = PROVIDERS.find((provider) => provider.id === "anthropic")!;
    const PricingPanel = await freshPanel();
    renderSlot<object, RpcContract>(
      { component: PricingPanel },
      {},
      { codeTheme: { mode: "dark" }, rpc: { load: () => ({ rows: [row()], sources: [ok("models-dev")] }) } },
    );
    await screen.findByText("Claude Opus 5");
    const platform = screen.getAllByText("Anthropic").find((element) => element.style.color !== "");
    expect(platform?.style.color).toBe(hexToRgb(anthropic.accent.dark));
  });

  it("shows a failed source beside the rows that still loaded", async () => {
    const PricingPanel = await freshPanel();
    renderSlot<object, RpcContract>(
      { component: PricingPanel },
      {},
      {
        rpc: {
          load: () => ({
            rows: [row()],
            sources: [ok("models-dev"), { id: "openrouter", fetchedAt: 0, cached: false, error: "OpenRouter answered 503" }],
          }),
        },
      },
    );
    await screen.findByText("Claude Opus 5");
    expect(screen.getByText("OpenRouter answered 503")).toBeTruthy();
  });

  it("lays rows out as cards in a narrow panel, each linking to its model's page", async () => {
    width = 400;
    const PricingPanel = await freshPanel();
    renderSlot<object, RpcContract>(
      { component: PricingPanel },
      {},
      { rpc: { load: () => ({ rows: [row()], sources: [ok("models-dev")] }) } },
    );
    await screen.findByText("Claude Opus 5");
    // No sortable headings in the card layout.
    expect(screen.queryByRole("button", { name: /Sort by/ })).toBeNull();
    expect(screen.getByText(/\$5 in · \$25 out/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Claude Opus 5 on Anthropic" });
    expect(link.getAttribute("href")).toBe("https://platform.claude.com/docs/en/models/opus-5/overview");
  });

  it("repaints from the last answer on a return visit instead of fetching again", async () => {
    const PricingPanel = await freshPanel();
    const options = { rpc: { load: () => ({ rows: ROWS, sources: [ok("models-dev")] }) } };
    const first = renderSlot<object, RpcContract>({ component: PricingPanel }, {}, options);
    await screen.findByText("Claude Opus 5");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Model" }));
    cleanup();

    const second = renderSlot<object, RpcContract>({ component: PricingPanel }, {}, options);
    expect(screen.getByText("Claude Opus 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model, sorted ascending" })).toBeTruthy();
    await waitFor(() => expect(first.rpcCalls.length + second.rpcCalls.length).toBe(1));
  });
});

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
