/** Following bb's "Copy on select" setting, which the SDK reads only on request. */
import { describe, expect, it, vi } from "vitest";

import { COPY_ON_SELECT_FRESH_MS, CopyOnSelectSetting } from "./copy-on-select";

function reader(values: (boolean | undefined | Error)[]) {
  const config = vi.fn(async () => {
    const next = values.shift();
    if (next instanceof Error) throw next;
    return { generalSettings: next === undefined ? {} : { terminalCopyOnSelect: next } };
  });
  return { config };
}

describe("CopyOnSelectSetting", () => {
  it("knows nothing before the first answer, then follows it", async () => {
    const setting = new CopyOnSelectSetting(reader([false]));
    expect(setting.current()).toBeNull();
    expect(await setting.resolve()).toBe(false);
    expect(setting.current()).toBe(false);
  });

  it("takes bb's default, on, when the setting is missing", async () => {
    expect(await new CopyOnSelectSetting(reader([undefined])).resolve()).toBe(true);
  });

  it("picks up a change made in Settings on a later read", async () => {
    let now = 0;
    const source = reader([true, false]);
    const setting = new CopyOnSelectSetting(source, () => now);
    expect(await setting.refresh()).toBe(true);
    now += COPY_ON_SELECT_FRESH_MS;
    expect(await setting.refresh()).toBe(false);
    expect(source.config).toHaveBeenCalledTimes(2);
  });

  it("asks once while a read is on its way or was made just now", async () => {
    let now = 0;
    const source = reader([true, false]);
    const setting = new CopyOnSelectSetting(source, () => now);
    await Promise.all([setting.refresh(), setting.refresh(), setting.resolve()]);
    now += COPY_ON_SELECT_FRESH_MS - 1;
    expect(await setting.refresh()).toBe(true);
    expect(source.config).toHaveBeenCalledTimes(1);
  });

  it("keeps the last answer when a read fails, and bb's default before any", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 0;
    const setting = new CopyOnSelectSetting(reader([new Error("down"), false, new Error("down")]), () => now);
    expect(await setting.refresh()).toBe(true);
    expect(setting.current()).toBeNull();
    now += COPY_ON_SELECT_FRESH_MS;
    expect(await setting.refresh()).toBe(false);
    now += COPY_ON_SELECT_FRESH_MS;
    expect(await setting.refresh()).toBe(false);
  });

  it("treats a reader that throws instead of rejecting as a failed read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setting = new CopyOnSelectSetting({
      config: () => {
        throw new Error("no fake");
      },
    });
    expect(await setting.refresh()).toBe(true);
  });
});

describe("a selection's answer", () => {
  it("waits for the read its press started rather than taking the older answer", async () => {
    let now = 0;
    const setting = new CopyOnSelectSetting(reader([false, true]), () => now);
    await setting.refresh();
    now += COPY_ON_SELECT_FRESH_MS;
    void setting.refresh();
    expect(await setting.resolve()).toBe(true);
  });
});
