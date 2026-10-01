import { describe, expect, it } from "vitest";

import { Versions } from "./versions";

describe("Versions", () => {
  it("adopts answers in start order, whatever order they land in", () => {
    const versions = new Versions();
    const first = versions.begin();
    const second = versions.begin();
    expect(versions.adopt(second)).toBe(true);
    expect(versions.adopt(first)).toBe(false);
  });

  it("adopts an older answer that lands first, then the newer one", () => {
    const versions = new Versions();
    const first = versions.begin();
    const second = versions.begin();
    expect(versions.adopt(first)).toBe(true);
    expect(versions.adopt(second)).toBe(true);
  });

  it("lets a push beat a fetch or save still in flight", () => {
    const versions = new Versions();
    const fetch = versions.begin();
    const push = versions.begin();
    expect(versions.adopt(push)).toBe(true);
    expect(versions.adopt(fetch)).toBe(false);
  });

  it("shows a failure only if nothing started after it", () => {
    const versions = new Versions();
    const fetch = versions.begin();
    expect(versions.mayFail(fetch)).toBe(true);
    const push = versions.begin();
    versions.adopt(push);
    expect(versions.mayFail(fetch)).toBe(false);
    expect(versions.mayFail(push)).toBe(true);
  });

  it("still reports the newest request's failure after an older one landed", () => {
    const versions = new Versions();
    const older = versions.begin();
    const newer = versions.begin();
    versions.adopt(older);
    expect(versions.mayFail(newer)).toBe(true);
  });
});
