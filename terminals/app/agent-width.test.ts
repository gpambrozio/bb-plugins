// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_WIDTH,
  MIN_AGENT_WIDTH,
  clampAgentWidth,
  maxAgentWidth,
  readAgentWidth,
  saveAgentWidth,
} from "./agent-width";

afterEach(() => window.localStorage.clear());

describe("the agent panel's width", () => {
  it("keeps the panel at least its minimum, at most three quarters of the row, and the terminal at least 240 px", () => {
    expect(maxAgentWidth(1600)).toBe(1200);
    expect(maxAgentWidth(800)).toBe(560);
    expect(maxAgentWidth(400)).toBe(MIN_AGENT_WIDTH);
    expect(clampAgentWidth(100, 1600)).toBe(MIN_AGENT_WIDTH);
    expect(clampAgentWidth(5000, 1600)).toBe(1200);
    expect(clampAgentWidth(612.4, 1600)).toBe(612);
    expect(clampAgentWidth(5000, 0)).toBe(5000);
  });

  it("is remembered in this browser, and starts at the default without a usable value", () => {
    expect(readAgentWidth()).toBe(DEFAULT_AGENT_WIDTH);
    saveAgentWidth(640.2);
    expect(readAgentWidth()).toBe(640);
    window.localStorage.setItem("terminals.agentPanelWidth", "wide");
    expect(readAgentWidth()).toBe(DEFAULT_AGENT_WIDTH);
    window.localStorage.setItem("terminals.agentPanelWidth", "12");
    expect(readAgentWidth()).toBe(DEFAULT_AGENT_WIDTH);
  });
});
