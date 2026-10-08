import { describe, expect, it } from "vitest";

import { CloseCode } from "../shared/channels";
import { endMessage } from "./end-message";

const closed = (code: number, reason = "") => ({ close: { code, reason }, securityFailure: null, connected: true });

describe("endMessage", () => {
  it("says why the server ended a session", () => {
    expect(endMessage(closed(CloseCode.idle))).toBe("Closed after 30 minutes without activity.");
    expect(endMessage(closed(CloseCode.maxAge))).toBe("Closed after 8 hours, the longest a session lasts.");
    expect(endMessage(closed(CloseCode.closedByUser))).toBe("Closed from bb with Close all.");
    expect(endMessage(closed(CloseCode.stopping))).toBe("Closed because the Screen Sharing plugin stopped or reloaded.");
  });

  it("passes on the relay's own reasons", () => {
    expect(endMessage(closed(CloseCode.failed, "cannot reach Screen Sharing (ECONNREFUSED)"))).toBe(
      "Cannot reach Screen Sharing (ECONNREFUSED).",
    );
    expect(endMessage(closed(CloseCode.policy, "expired ticket"))).toBe("bb refused the session (expired ticket). Try again.");
  });

  it("puts a refused sign-in first", () => {
    expect(endMessage({ close: { code: 1000, reason: "" }, securityFailure: "Authentication failed", connected: false })).toBe(
      "Sign-in failed: Authentication failed.",
    );
  });

  it("tells a lost connection from one Screen Sharing ended", () => {
    expect(endMessage(closed(1006))).toBe("The connection was lost.");
    expect(endMessage({ ...closed(1006), connected: false })).toBe("Could not connect to the relay.");
    expect(endMessage(closed(CloseCode.normal))).toBe("Screen Sharing ended the session.");
    expect(endMessage({ close: null, securityFailure: null, connected: true })).toBe("Disconnected.");
  });
});
