import { describe, expect, it } from "vitest";

import { relayUrl } from "./relay-url";

describe("relayUrl", () => {
  it("is wss on an https origin, through the getbb.app tunnel", () => {
    expect(relayUrl("https://me.getbb.app", "host_mini", "t0k")).toBe(
      "wss://me.getbb.app/api/v1/plugins/screen-sharing/http/vnc?host=host_mini&flow=ack-ping&token=t0k",
    );
  });

  it("is ws on the loopback server", () => {
    expect(relayUrl("http://127.0.0.1:38886", "host_mini", "t0k")).toBe(
      "ws://127.0.0.1:38886/api/v1/plugins/screen-sharing/http/vnc?host=host_mini&flow=ack-ping&token=t0k",
    );
  });

  it("names a protocol a relay from before liveness turns away, so its first ping cannot end the session", () => {
    // 0.2.0's relay refused any flow but "ack" before redeeming the ticket, saying to reload bb;
    // it accepted "ack" and then closed the session (1008) on the page's first ping.
    expect(new URL(relayUrl("https://me.getbb.app", "host_mini", "t0k")).searchParams.get("flow")).not.toBe("ack");
  });

  it("encodes what it is given", () => {
    expect(relayUrl("http://127.0.0.1:1", "a b", "x&y=z")).toContain("?host=a+b&flow=ack-ping&token=x%26y%3Dz");
  });
});
