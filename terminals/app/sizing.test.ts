/**
 * Who sizes a shell shown in several windows: the one in use asks bb, and
 * every one draws what bb reports. A fake bb applies each request and reports
 * the new size to every window, as bb 0.48.1's terminals.resize does.
 */
import { describe, expect, it } from "vitest";

import { TerminalSizing, type Size } from "./sizing";

function fakeBb(initial: Size) {
  const windows: TerminalSizing[] = [];
  const pending: { size: Size; resolve: () => void; reject: (error: Error) => void }[] = [];
  const bb = {
    size: initial,
    claims: [] as Size[],
    offline: false,
    /** Answers held requests, applying each and reporting it to every window. */
    answer(count = pending.length) {
      for (const request of pending.splice(0, count)) {
        if (bb.offline) {
          request.reject(new Error("host_disconnected"));
          continue;
        }
        bb.size = request.size;
        for (const window of windows) window.sessionChanged(request.size);
        request.resolve();
      }
    },
    window() {
      const drawn: Size[] = [];
      let local = initial;
      const sizing = new TerminalSizing({
        localSize: () => local,
        resizeLocal: (size) => {
          local = size;
          drawn.push(size);
        },
        claim: (size) => {
          bb.claims.push(size);
          return new Promise<void>((resolve, reject) => pending.push({ size, resolve, reject }));
        },
        warn: () => undefined,
      });
      windows.push(sizing);
      sizing.sessionChanged(bb.size);
      return { sizing, drawn, local: () => local };
    },
  };
  return bb;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TerminalSizing", () => {
  it("gives the shell the size of the window in use, once", async () => {
    const bb = fakeBb({ cols: 80, rows: 24 });
    const desktop = bb.window();
    desktop.sizing.fitted({ cols: 150, rows: 45 });
    desktop.sizing.fitted({ cols: 150, rows: 45 });
    expect(desktop.local()).toEqual({ cols: 150, rows: 45 });
    bb.answer();
    await settle();
    desktop.sizing.fitted({ cols: 150, rows: 45 });
    expect(bb.claims).toEqual([{ cols: 150, rows: 45 }]);
    expect(bb.size).toEqual({ cols: 150, rows: 45 });
  });

  it("asks for the latest size only while a window is being resized, without drawing the older ones", async () => {
    const bb = fakeBb({ cols: 80, rows: 24 });
    const desktop = bb.window();
    desktop.sizing.fitted({ cols: 100, rows: 30 });
    desktop.sizing.fitted({ cols: 110, rows: 32 });
    desktop.sizing.fitted({ cols: 120, rows: 34 });
    bb.answer();
    await settle();
    bb.answer();
    await settle();
    expect(bb.claims).toEqual([
      { cols: 100, rows: 30 },
      { cols: 120, rows: 34 },
    ]);
    expect(desktop.drawn).toEqual([
      { cols: 100, rows: 30 },
      { cols: 110, rows: 32 },
      { cols: 120, rows: 34 },
    ]);
    expect(bb.size).toEqual({ cols: 120, rows: 34 });
  });

  it("draws the shell at the size another window gave it", async () => {
    const bb = fakeBb({ cols: 150, rows: 45 });
    const desktop = bb.window();
    const phone = bb.window();
    phone.sizing.fitted({ cols: 40, rows: 30 });
    bb.answer();
    await settle();
    expect(desktop.local()).toEqual({ cols: 40, rows: 30 });
    expect(desktop.sizing.differs).toBe(false);
  });

  it("takes the shell back when the user returns to the older window while the newer one's page is away", async () => {
    const bb = fakeBb({ cols: 80, rows: 24 });
    const desktop = bb.window();
    const web = bb.window();
    desktop.sizing.fitted({ cols: 150, rows: 45 });
    bb.answer();
    await settle();
    // The narrow web window opens the page (it attached last), then leaves it: it never asks again.
    web.sizing.fitted({ cols: 60, rows: 20 });
    bb.answer();
    await settle();
    expect(bb.size).toEqual({ cols: 60, rows: 20 });
    expect(desktop.local()).toEqual({ cols: 60, rows: 20 });
    // Back on the desktop: its view fits 150×45 again (focus, typing, or showing the tab).
    desktop.sizing.fitted({ cols: 150, rows: 45 });
    bb.answer();
    await settle();
    expect(bb.size).toEqual({ cols: 150, rows: 45 });
    expect(desktop.local()).toEqual({ cols: 150, rows: 45 });
    // The web window, away, follows without asking.
    expect(web.local()).toEqual({ cols: 150, rows: 45 });
    expect(bb.claims).toHaveLength(3);
  });

  it("takes the shell back when the user types in a window that never lost focus", async () => {
    const bb = fakeBb({ cols: 80, rows: 24 });
    const desktop = bb.window();
    const phone = bb.window();
    const desktopView = { cols: 150, rows: 45 };
    let measured = 0;
    const measure = () => {
      measured += 1;
      return desktopView;
    };
    desktop.sizing.fitted(desktopView);
    bb.answer();
    await settle();
    // Typing while the desktop has the shell reads no layout and asks nothing.
    desktop.sizing.typed(measure);
    expect(measured).toBe(0);
    // A phone opens the page and sizes the shell; the desktop, still focused, follows.
    phone.sizing.fitted({ cols: 60, rows: 20 });
    bb.answer();
    await settle();
    expect(desktop.local()).toEqual({ cols: 60, rows: 20 });
    // No focus or resize event on the desktop: the user just types there again.
    desktop.sizing.typed(measure);
    bb.answer();
    await settle();
    expect(bb.size).toEqual(desktopView);
    expect(desktop.local()).toEqual(desktopView);
    desktop.sizing.typed(measure);
    expect(measured).toBe(1);
    expect(bb.claims).toHaveLength(3);
  });

  it("asks again after bb could not resize, such as while the machine was offline", async () => {
    const bb = fakeBb({ cols: 80, rows: 24 });
    const desktop = bb.window();
    bb.offline = true;
    desktop.sizing.fitted({ cols: 120, rows: 40 });
    bb.answer();
    await settle();
    expect(bb.size).toEqual({ cols: 80, rows: 24 });
    expect(desktop.sizing.differs).toBe(true);
    bb.offline = false;
    desktop.sizing.fitted({ cols: 120, rows: 40 });
    bb.answer();
    await settle();
    expect(bb.size).toEqual({ cols: 120, rows: 40 });
  });
});
