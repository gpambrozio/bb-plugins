import { describe, expect, it } from "vitest";

import { relayUrl } from "./relay-url";

describe("relayUrl", () => {
  it("is wss on an https origin, through the getbb.app tunnel", () => {
    expect(relayUrl("https://me.getbb.app", "host_mini", "t0k")).toBe(
      "wss://me.getbb.app/api/v1/plugins/screen-sharing/http/vnc?host=host_mini&token=t0k",
    );
  });

  it("is ws on the loopback server", () => {
    expect(relayUrl("http://127.0.0.1:38886", "host_mini", "t0k")).toBe(
      "ws://127.0.0.1:38886/api/v1/plugins/screen-sharing/http/vnc?host=host_mini&token=t0k",
    );
  });

  it("encodes what it is given", () => {
    expect(relayUrl("http://127.0.0.1:1", "a b", "x&y=z")).toContain("?host=a+b&token=x%26y%3Dz");
  });
});
