/**
 * Whether the FirstMate tab can be seen: bb keeps a closed panel's tabs mounted, so the board asks before
 * it reads. `experimental_useTabVisible` is bb 0.48's; bb 0.47 has no such member, and the SDK's
 * forwarder throws on the call. It throws there on every render, before any hook of its own runs, so
 * the hooks this component calls stay the same from render to render; the board then reads as it did
 * before 0.48, whether it can be seen or not.
 */
import { experimental_useTabVisible } from "@get-bb/plugin-sdk/app";

export function useTabVisible(): boolean {
  try {
    return experimental_useTabVisible();
  } catch {
    return true;
  }
}
