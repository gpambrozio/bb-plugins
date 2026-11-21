// briefing — the server entry. Registers the `bb briefing` CLI over bb's SDK; nothing else runs.
// The plugin keeps no state, sends nothing to any thread and writes nothing. See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { briefingCli } from "./server/cli";
import { sdkPorts } from "./server/sdk-ports";

export default async function plugin(bb: BbPluginApi) {
  bb.cli.register(briefingCli((signal) => sdkPorts(bb.sdk, signal)));
}
