// @vitest-environment jsdom
/** bb 0.47 has no `experimental_useTabVisible`: the SDK's forwarder throws, and the tab counts as shown. */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const visible = vi.hoisted(() => ({ answer: (): boolean => false }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_useTabVisible: () => visible.answer() }));

import { useTabVisible } from "./tab-visible";

describe("useTabVisible", () => {
  it("is bb's answer where bb has one", () => {
    visible.answer = () => false;
    expect(renderHook(() => useTabVisible()).result.current).toBe(false);
  });

  it("is true on a bb without it", () => {
    visible.answer = () => {
      throw new Error("@get-bb/plugin-sdk/app: experimental_useTabVisible needs the bb app's plugin runtime.");
    };
    expect(renderHook(() => useTabVisible()).result.current).toBe(true);
  });
});
