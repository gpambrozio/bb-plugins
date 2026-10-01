/**
 * What two instances of this plugin tell each other. A reload starts the new
 * instance before it disposes of the old one, so:
 *
 * - the new one reads storage while the old one may still be writing its last
 *   entries. When the old one has flushed and closed its storage, it says so
 *   here, and the new one reads storage again;
 * - the old one may still own summary helpers when its unload deadline passes.
 *   It hands each one over here, and the new one stops and deletes it.
 *
 * Both instances run in the bb server's one process, so the channel is an
 * `EventTarget` on `globalThis`, keyed by plugin id. Should bb ever run them
 * apart, the signal simply never arrives and nothing is worse than before.
 */
const DRAINED = "drained";
const HANDED_OVER = "helper-handed-over";

interface DrainedDetail {
  instance: string;
}

interface HandedOverDetail {
  instance: string;
  helperId: string;
  /** Set by the instance that takes the helper. */
  taken: boolean;
  /** Called by that instance once the helper is stopped and put away. */
  done: () => void;
}

function channel(pluginId: string): EventTarget {
  const key = Symbol.for(`bb-plugin:${pluginId}:reload-signal`);
  const holder = globalThis as Record<symbol, EventTarget | undefined>;
  holder[key] ??= new EventTarget();
  return holder[key];
}

/**
 * Gives a summary helper this instance can no longer put away to whichever
 * instance is live. Resolves once that instance has put it away — at once when
 * no instance took it, and the next load's sweep will.
 */
export function handOverHelper(pluginId: string, instance: string, helperId: string): Promise<void> {
  return new Promise((resolve) => {
    const detail: HandedOverDetail = { instance, helperId, taken: false, done: () => resolve() };
    channel(pluginId).dispatchEvent(new CustomEvent<HandedOverDetail>(HANDED_OVER, { detail }));
    if (!detail.taken) resolve();
  });
}

/**
 * Calls `listener` with each helper another instance hands over; the listener
 * calls `done` once it has put the helper away. Returns the unsubscribe.
 */
export function onHelperHandedOver(
  pluginId: string,
  instance: string,
  listener: (helperId: string, done: () => void) => void,
): () => void {
  const target = channel(pluginId);
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<HandedOverDetail>).detail;
    if (detail === undefined || detail.instance === instance || detail.taken) return;
    detail.taken = true;
    listener(detail.helperId, detail.done);
  };
  target.addEventListener(HANDED_OVER, handler);
  return () => target.removeEventListener(HANDED_OVER, handler);
}

/** Says this instance has flushed and closed its storage: it will write nothing more. */
export function announceDrained(pluginId: string, instance: string): void {
  channel(pluginId).dispatchEvent(new CustomEvent<DrainedDetail>(DRAINED, { detail: { instance } }));
}

/** Calls `listener` when another instance has drained; returns the unsubscribe. */
export function onOtherDrained(pluginId: string, instance: string, listener: () => void): () => void {
  const target = channel(pluginId);
  const handler = (event: Event) => {
    if ((event as CustomEvent<DrainedDetail>).detail?.instance !== instance) listener();
  };
  target.addEventListener(DRAINED, handler);
  return () => target.removeEventListener(DRAINED, handler);
}
