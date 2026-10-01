/**
 * The one thing two instances of this plugin tell each other. A reload starts
 * the new instance before it disposes of the old one, so the new one reads
 * storage while the old one may still be writing its last entries. When the
 * old one has closed and flushed its storage, it says so here, and the new one
 * reads storage again.
 *
 * Both instances run in the bb server's one process, so the channel is an
 * `EventTarget` on `globalThis`, keyed by plugin id. Should bb ever run them
 * apart, the signal simply never arrives and nothing is worse than before.
 */
const DRAINED = "drained";

interface DrainedDetail {
  instance: string;
}

function channel(pluginId: string): EventTarget {
  const key = Symbol.for(`bb-plugin:${pluginId}:reload-signal`);
  const holder = globalThis as Record<symbol, EventTarget | undefined>;
  holder[key] ??= new EventTarget();
  return holder[key];
}

/** Says this instance has closed and flushed its storage: it will write nothing more. */
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
