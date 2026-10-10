/**
 * Scrolling into RFB wheel steps: in proportion to the distance times the
 * "Scroll speed" setting, with the remainder carried to the next event —
 * where noVNC sends one step per event at most and drops the rest.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SCROLL_SPEED } from "../shared/settings";
import { MAX_WHEEL_STEPS, WHEEL_LINE_PX, WHEEL_STEP_PX, WheelAccumulator } from "./wheel";

const pixels = (deltaY: number, deltaX = 0) => ({ deltaX, deltaY, deltaMode: 0 });

describe("wheel steps", () => {
  it("sends as many steps as one event's distance holds, at speed 1", () => {
    const steps = new WheelAccumulator();
    expect(steps.add(pixels(5 * WHEEL_STEP_PX), 1)).toEqual({ x: 0, y: 5 });
    expect(steps.add(pixels(-3 * WHEEL_STEP_PX, 2 * WHEEL_STEP_PX), 1)).toEqual({ x: 2, y: -3 });
  });

  it("sends three times as many at the default speed, and five at the fastest", () => {
    expect(DEFAULT_SCROLL_SPEED).toBe(3);
    expect(new WheelAccumulator().add(pixels(5 * WHEEL_STEP_PX), DEFAULT_SCROLL_SPEED)).toEqual({ x: 0, y: 15 });
    expect(new WheelAccumulator().add(pixels(-2 * WHEEL_STEP_PX), 5)).toEqual({ x: 0, y: -10 });
  });

  it("carries a trackpad's small movements over until they make a step, losing none", () => {
    for (const speed of [1, DEFAULT_SCROLL_SPEED, 5]) {
      const steps = new WheelAccumulator();
      let sent = 0;
      // A trackpad gesture: 60 events of 7 px, 420 px in all.
      for (let event = 0; event < 60; event++) sent += steps.add(pixels(7), speed).y;
      expect(sent).toBe(Math.floor((60 * 7 * speed) / WHEEL_STEP_PX));
    }
  });

  it("starts afresh when the scrolling turns the other way", () => {
    const steps = new WheelAccumulator();
    expect(steps.add(pixels(WHEEL_STEP_PX - 1), 1)).toEqual({ x: 0, y: 0 });
    expect(steps.add(pixels(-WHEEL_STEP_PX), 1)).toEqual({ x: 0, y: -1 });
  });

  it("counts lines and pages as well as pixels", () => {
    expect(new WheelAccumulator().add({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 1)).toEqual({ x: 0, y: Math.trunc((3 * WHEEL_LINE_PX) / WHEEL_STEP_PX) });
    expect(new WheelAccumulator().add({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 1).y).toBeGreaterThan(1);
  });

  it("never sends more than a bounded number of steps for one event, a bound that grows with the speed", () => {
    const steps = new WheelAccumulator();
    expect(steps.add(pixels(1000 * WHEEL_STEP_PX), 1)).toEqual({ x: 0, y: MAX_WHEEL_STEPS });
    // The excess is dropped, not saved up for later.
    expect(steps.add(pixels(1), 1)).toEqual({ x: 0, y: 0 });
    expect(new WheelAccumulator().add(pixels(1000 * WHEEL_STEP_PX), DEFAULT_SCROLL_SPEED).y).toBe(MAX_WHEEL_STEPS * DEFAULT_SCROLL_SPEED);
  });
});
