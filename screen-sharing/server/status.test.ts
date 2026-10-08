import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { checkScreenSharing, clientVersionLine, parseScreenSharingDisabled, probeRfb, type StatusChecks } from "./status";

describe("clientVersionLine", () => {
  it("never asks for more than the server offers", () => {
    expect(clientVersionLine(3, 889, "RFB 003.889\n")).toBe("RFB 003.008\n");
    expect(clientVersionLine(3, 8, "RFB 003.008\n")).toBe("RFB 003.008\n");
    expect(clientVersionLine(3, 7, "RFB 003.007\n")).toBe("RFB 003.007\n");
    expect(clientVersionLine(3, 3, "RFB 003.003\n")).toBe("RFB 003.003\n");
  });
});

describe("parseScreenSharingDisabled", () => {
  const output = (value: string) => `disabled services = {\n\t"com.apple.ftp-proxy" => disabled\n\t"com.apple.screensharing" => ${value}\n}\n`;

  it("reads the switch in either spelling", () => {
    expect(parseScreenSharingDisabled(output("enabled"))).toBe(false);
    expect(parseScreenSharingDisabled(output("disabled"))).toBe(true);
    expect(parseScreenSharingDisabled(output("false"))).toBe(false);
    expect(parseScreenSharingDisabled(output("true"))).toBe(true);
  });

  it("does not guess when the service is not listed", () => {
    expect(parseScreenSharingDisabled('disabled services = {\n\t"com.apple.ftp-proxy" => disabled\n}\n')).toBeNull();
  });
});

describe("checkScreenSharing", () => {
  function checks(overrides: Partial<StatusChecks>): StatusChecks {
    return {
      platform: "darwin",
      probe: async () => null,
      serviceDisabled: async () => null,
      ...overrides,
    };
  }

  it("is ready when an RFB server answers, whatever launchctl says", async () => {
    const result = await checkScreenSharing(
      checks({
        probe: async () => ({ version: "RFB 003.889", securityTypes: [30, 33, 36, 35], refusedReason: null }),
        serviceDisabled: async () => true,
      }),
    );
    expect(result).toEqual({
      state: "ready",
      rfbVersion: "RFB 003.889",
      securityTypes: [30, 33, 36, 35],
      signInSupported: true,
      refusedReason: null,
    });
  });

  it("flags a server offering only sign-in methods noVNC lacks", async () => {
    const result = await checkScreenSharing(
      checks({ probe: async () => ({ version: "RFB 003.889", securityTypes: [33, 35, 36], refusedReason: null }) }),
    );
    expect(result.state).toBe("ready");
    expect(result.signInSupported).toBe(false);
  });

  it("is refused when the server answers with no sign-in methods at all", async () => {
    const result = await checkScreenSharing(
      checks({ probe: async () => ({ version: "RFB 003.889", securityTypes: [], refusedReason: "Too many authentication failures" }) }),
    );
    expect(result).toMatchObject({ state: "refused", refusedReason: "Too many authentication failures" });
  });

  it("is off when nothing answers and macOS has it switched off", async () => {
    expect((await checkScreenSharing(checks({ serviceDisabled: async () => true }))).state).toBe("off");
  });

  it("is not listening when nothing answers and macOS does not say off", async () => {
    expect((await checkScreenSharing(checks({ serviceDisabled: async () => false }))).state).toBe("not-listening");
    expect((await checkScreenSharing(checks({}))).state).toBe("not-listening");
  });

  it("is unsupported off macOS, without probing", async () => {
    let probed = false;
    const result = await checkScreenSharing(
      checks({
        platform: "linux",
        probe: async () => {
          probed = true;
          return null;
        },
      }),
    );
    expect(result.state).toBe("unsupported");
    expect(probed).toBe(false);
  });
});

describe("probeRfb", () => {
  let server: Server | null = null;
  let clientSent: Buffer[] = [];

  async function listen(onConnection: (socket: Socket) => void): Promise<number> {
    clientSent = [];
    server = createServer((socket) => {
      socket.on("data", (chunk) => clientSent.push(chunk));
      socket.on("error", () => {});
      onConnection(socket);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
    server = null;
  });

  it("reads Apple's greeting and sign-in methods, and signs in to nothing", async () => {
    const port = await listen((socket) => {
      socket.write("RFB 003.889\n");
      socket.once("data", () => socket.write(Buffer.from([4, 30, 33, 36, 35])));
    });
    expect(await probeRfb(port)).toEqual({ version: "RFB 003.889", securityTypes: [30, 33, 36, 35], refusedReason: null });
    expect(Buffer.concat(clientSent).toString("latin1")).toBe("RFB 003.008\n");
  });

  it("reads an RFB 3.3 server's single type", async () => {
    const port = await listen((socket) => {
      socket.write("RFB 003.003\n");
      socket.once("data", () => {
        const type = Buffer.alloc(4);
        type.writeUInt32BE(2);
        socket.write(type);
      });
    });
    expect(await probeRfb(port)).toEqual({ version: "RFB 003.003", securityTypes: [2], refusedReason: null });
    expect(Buffer.concat(clientSent).toString("latin1")).toBe("RFB 003.003\n");
  });

  it("copes with the greeting arriving in pieces", async () => {
    const port = await listen((socket) => {
      socket.write("RFB 00");
      setTimeout(() => socket.write("3.889\n"), 10);
      socket.once("data", () => {
        socket.write(Buffer.from([2]));
        setTimeout(() => socket.write(Buffer.from([30, 2])), 10);
      });
    });
    expect(await probeRfb(port)).toEqual({ version: "RFB 003.889", securityTypes: [30, 2], refusedReason: null });
  });

  it("asks a 3.7 server for 3.7, never more than it offers", async () => {
    const port = await listen((socket) => {
      socket.write("RFB 003.007\n");
      socket.once("data", () => socket.write(Buffer.from([1, 2])));
    });
    expect(await probeRfb(port)).toEqual({ version: "RFB 003.007", securityTypes: [2], refusedReason: null });
    expect(Buffer.concat(clientSent).toString("latin1")).toBe("RFB 003.007\n");
  });

  it("reads the reason a server gives for turning the connection away", async () => {
    const port = await listen((socket) => {
      socket.write("RFB 003.889\n");
      socket.once("data", () => {
        const reason = Buffer.from("Too many authentication failures");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(reason.length);
        socket.write(Buffer.concat([Buffer.from([0]), length]));
        setTimeout(() => socket.write(reason), 10);
      });
    });
    expect(await probeRfb(port)).toEqual({
      version: "RFB 003.889",
      securityTypes: [],
      refusedReason: "Too many authentication failures",
    });
  });

  it("is null for something that is not RFB", async () => {
    const port = await listen((socket) => socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"));
    expect(await probeRfb(port)).toBeNull();
  });

  it("is null when nothing listens", async () => {
    const port = await listen(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    expect(await probeRfb(port)).toBeNull();
  });

  it("is null when the server says nothing in time", async () => {
    const port = await listen(() => {});
    expect(await probeRfb(port, 100)).toBeNull();
  });
});
