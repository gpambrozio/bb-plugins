/**
 * Scrolling, turned into RFB wheel steps. RFB has no scroll distance: a step
 * is a press and release of button 4 or 5 (6 and 7 sideways), and the Mac
 * scrolls a fixed amount for each. noVNC 1.7.0 sends at most one step per
 * browser wheel event, once 50 px have gathered, and throws away whatever is
 * left over — so a fast flick or a wheel notch of 100 px or more sends one
 * step, and a trackpad gesture sends one per 50 px. Scrolling the Mac felt
 * many times slower than scrolling the page.
 *
 * Here scrolling is turned into as many steps as one event's distance holds,
 * and the remainder carries over to the next event; the "Scroll speed"
 * setting (shared/settings.ts, 1 to 5) multiplies the steps. Tried on the bb
 * server's own Mac, with no link delay: a step per line of scrolling (20 px)
 * moved the remote page far too little, and five steps per line felt right.
 * So the default, 3, is a step per 4 px, and each speed s is s/3 of that.
 */

import { DEFAULT_SCROLL_SPEED } from "../shared/settings";

/** Scrolling per step at speed 1: 4 px at the default speed of 3. */
export const WHEEL_STEP_PX = 12;
/** noVNC's figure for a scroll given in lines (deltaMode 1) rather than pixels. */
export const WHEEL_LINE_PX = 19;
/** At the default speed, one wheel event never sends more than this many steps per direction; the rest is dropped. */
const MAX_WHEEL_STEPS = 80;

/** The most steps one wheel event sends per direction at `speed`, in proportion to the default's. */
export function maxWheelSteps(speed: number): number {
  return Math.round((MAX_WHEEL_STEPS * speed) / DEFAULT_SCROLL_SPEED);
}

/** DOM WheelEvent.deltaMode values. */
const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_PAGE = 2;
/** A page of scrolling, when the browser gives one: about a screenful of lines. */
const LINES_PER_PAGE = 30;

export interface WheelSteps {
  /** Steps sideways: negative is left (button 6), positive right (button 7). */
  x: number;
  /** Steps up and down: negative is up (button 4), positive down (button 5). */
  y: number;
}

/** Scrolling gathered between wheel events, on both axes. */
export class WheelAccumulator {
  private x = 0;
  private y = 0;

  /** The steps `event` adds at `speed` (1–5), keeping what is left over for the next one. */
  add(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">, speed: number): WheelSteps {
    const pixels = event.deltaMode === DOM_DELTA_PIXEL ? 1 : event.deltaMode === DOM_DELTA_PAGE ? WHEEL_LINE_PX * LINES_PER_PAGE : WHEEL_LINE_PX;
    // What is gathered is scrolling times the speed, so the steps grow with it.
    const scale = pixels * speed;
    this.x = this.sameWay(this.x, event.deltaX) + event.deltaX * scale;
    this.y = this.sameWay(this.y, event.deltaY) + event.deltaY * scale;
    const x = this.take(this.x);
    const y = this.take(this.y);
    this.x -= x * WHEEL_STEP_PX;
    this.y -= y * WHEEL_STEP_PX;
    return { x: clamp(x, maxWheelSteps(speed)), y: clamp(y, maxWheelSteps(speed)) };
  }

  /** A turn the other way starts afresh, rather than first paying back what was left over. */
  private sameWay(gathered: number, delta: number): number {
    return gathered !== 0 && delta !== 0 && Math.sign(gathered) !== Math.sign(delta) ? 0 : gathered;
  }

  private take(gathered: number): number {
    return Math.trunc(gathered / WHEEL_STEP_PX);
  }
}

function clamp(steps: number, most: number): number {
  return Math.max(-most, Math.min(most, steps));
}
