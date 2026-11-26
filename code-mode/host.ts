// code-mode — the host entry. It runs on each machine where a thread runs in Code Mode, in a worker
// bb's host daemon starts there, and writes the wrapper into this plugin's host-data folder on that
// machine (host/install.ts). The server calls it before it hands bb the wrapper for a thread.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { installWrapper } from "./host/install";
import { hostContract } from "./shared/host-contract";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    install: (_input, context) =>
      installWrapper({ dataDir: context.experimental_paths.dataDir, node: process.execPath, platform: process.platform }),
  },
});
