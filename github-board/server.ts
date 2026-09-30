// GitHub Board — the server entry.
//
// The GitHub queries (server/github.ts), the `gh` transport (server/gh.ts) and
// the image fetch (server/image.ts) are ported and tested. The RPC contract,
// settings and the send-to-thread flow are wired once three decisions are made:
// where `gh` runs, how a card finds its bb project, and which new-thread UI
// the send uses. See github-board/AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
