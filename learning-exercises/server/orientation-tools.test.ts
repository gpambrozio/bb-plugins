import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { OrientationService } from "./orientation";
import { ORIENT_TOOL_NAMES, registerOrientationTools } from "./orientation-tools";
import { FakePorts } from "./testing/fake-ports";
import { memoryOrientationStore, settingsWith } from "./testing/store";

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
  const { orientations } = memoryOrientationStore();
  registerOrientationTools(bb, new OrientationService(new FakePorts(), orientations, () => settingsWith()));
  return { harness };
}

describe("the orient tools", () => {
  it("registers the six tools, none with a $ref in its schema", () => {
    const { harness } = setup();
    expect(harness.registrations.agentTools.map((tool) => tool.name).sort()).toEqual([...ORIENT_TOOL_NAMES].sort());
    for (const tool of harness.registrations.agentTools) expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
  });

  it("refuses a call from a thread that is not building, as a tool error", async () => {
    const { harness } = setup();
    const result = await harness.callAgentTool("orient_listing", { path: "a.ts", lines: "1-3", caption: "x" }, { threadId: "thr_other" });
    expect(JSON.stringify(result)).toContain("not building an orientation");
  });
});
