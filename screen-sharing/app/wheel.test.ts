/**
 * Scrolling into RFB wheel steps: in proportion to the distance, with the
 * remainder carried to the next event — where noVNC sends one step per event
 * at most and drops the rest.
 */
import { describe, expect, it } from "vitest";

import { MAX_WHEEL_STEPS, WHEEL_LINE_PX, WHEEL_STEP_PX, WheelAccumulator } from "./wheel";

const pixels = (deltaY: number, deltaX = 0) => ({ deltaX, deltaY, deltaMode: 0 });

describe("wheel steps", () => {
  it("sends as many steps as one event's distance holds", () => {
    const steps = new WheelAccumulator();
    expect(steps.add(pixels(5 * WHEEL_STEP_PX))).toEqual({ x: 0, y: 5 });
    expect(steps.add(pixels(-3 * WHEEL_STEP_PX, 2 * WHEEL_STEP_PX))).toEqual({ x: 2, y: -3 });
  });

  it("carries a trackpad's small movements over until they make a step, losing none", () => {
    const steps = new WheelAccumulator();
    let sent = 0;
    // A trackpad gesture: 60 events of 7 px, 420 px in all.
    for (let event = 0; event < 60; event++) sent += steps.add(pixels(7)).y;
    expect(sent).toBe(Math.floor((60 * 7) / WHEEL_STEP_PX));
  });

  it("starts afresh when the scrolling turns the other way", () => {
    const steps = new WheelAccumulator();
    expect(steps.add(pixels(WHEEL_STEP_PX - 1))).toEqual({ x: 0, y: 0 });
    expect(steps.add(pixels(-WHEEL_STEP_PX))).toEqual({ x: 0, y: -1 });
  });

  it("counts lines and pages as well as pixels", () => {
    expect(new WheelAccumulator().add({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ x: 0, y: Math.trunc((3 * WHEEL_LINE_PX) / WHEEL_STEP_PX) });
    expect(new WheelAccumulator().add({ deltaX: 0, deltaY: 1, deltaMode: 2 }).y).toBeGreaterThan(1);
  });

  it("never sends more than a bounded number of steps for one event", () => {
    const steps = new WheelAccumulator();
    expect(steps.add(pixels(1000 * WHEEL_STEP_PX))).toEqual({ x: 0, y: MAX_WHEEL_STEPS });
    // The excess is dropped, not saved up for later.
    expect(steps.add(pixels(1))).toEqual({ x: 0, y: 0 });
  });
});
