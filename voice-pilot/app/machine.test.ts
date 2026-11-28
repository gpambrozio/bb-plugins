import { describe, expect, it } from "vitest";

import { createLocalHostLookup, findLocalHostId } from "./machine";

const SERVER = "http://127.0.0.1:38886";

function status(hostId: string, serverUrl: string, connected = true) {
  return { hostId, serverUrl, connected };
}

describe("finding this window's machine", () => {
  it("is the host daemon here connected to the server this window shows", async () => {
    const statuses: Record<number, unknown> = { 1: status("host_other", "https://bb.example"), 2: status("host_mine", `${SERVER}/`) };
    await expect(findLocalHostId([1, 2], SERVER, async (port) => statuses[port])).resolves.toBe("host_mine");
  });

  it("takes the first connected daemon when none names this window's server, as bb does", async () => {
    const statuses: Record<number, unknown> = { 1: status("host_a", SERVER), 2: status("host_b", SERVER) };
    await expect(findLocalHostId([1, 2], "https://elsewhere.example", async (port) => statuses[port])).resolves.toBe("host_a");
  });

  it("is null with no daemon, one that does not answer, one not connected, or an answer it cannot read", async () => {
    await expect(findLocalHostId([], SERVER)).resolves.toBeNull();
    await expect(findLocalHostId([1], SERVER, async () => Promise.reject(new Error("refused")))).resolves.toBeNull();
    await expect(findLocalHostId([1], SERVER, async () => status("host_a", SERVER, false))).resolves.toBeNull();
    await expect(findLocalHostId([1], SERVER, async () => ({ nonsense: true }))).resolves.toBeNull();
  });

  it("is looked up once when found, again after a lookup that found nothing, and never rejects", async () => {
    let answer: unknown = null;
    let reads = 0;
    const lookup = createLocalHostLookup(async () => [1], () => SERVER, async () => (reads++, answer));
    await expect(lookup()).resolves.toBeNull();
    answer = status("host_mine", SERVER);
    await expect(lookup()).resolves.toBe("host_mine");
    await expect(lookup()).resolves.toBe("host_mine");
    expect(reads).toBe(2);
    const broken = createLocalHostLookup(async () => Promise.reject(new Error("no config")));
    await expect(broken()).resolves.toBeNull();
  });
});
