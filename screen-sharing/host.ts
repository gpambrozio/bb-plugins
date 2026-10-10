// screen-sharing — the host entry.
//
// Runs on every Mac enrolled in this bb, in a worker its host daemon starts
// there. It answers whether Screen Sharing is on, relays a session to that
// Mac's own Screen Sharing on 127.0.0.1:5900 for the server, over bb's host
// link (host/relay.ts), and reads and writes the Mac's clipboard beside it
// (host/pasteboard.ts). The Mac running the bb server is reached by the server
// directly, over loopback; this entry carries the others. Nothing listens and
// nothing is exposed. See AGENTS.md.
import { HOST_SILENCE_MS, HOST_WINDOW_BYTES, SCREEN_SHARING_PORT } from "./shared/limits";
import { createHostEntry } from "./host/entry";

export default createHostEntry({
  port: SCREEN_SHARING_PORT,
  windowBytes: HOST_WINDOW_BYTES,
  silenceMs: HOST_SILENCE_MS,
});
