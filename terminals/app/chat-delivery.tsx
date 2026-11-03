/**
 * Putting a terminal selection into a thread's composer, as a draft the user
 * sends themselves — never a message sent for them.
 *
 * The SDK writes only into composers on screen (`useComposers()`), and the
 * Terminals page shows none. So "Add to chat" leaves the block here and opens
 * the thread (or the New thread screen); `ChatDelivery`, mounted once per
 * window as an app overlay, sees that composer appear, adds the block to its
 * draft and focuses it. If no such composer shows up in time, the block goes
 * to the clipboard instead, so the selection is not lost.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { experimental_copyToClipboard, useComposers, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { appendToDraft } from "./chat-text";

/** The composer a block is for. */
export type DeliveryTarget = { kind: "thread"; threadId: string } | { kind: "new-thread"; projectId: string };

export interface Delivery {
  target: DeliveryTarget;
  /** The text to add, already formatted (app/chat-text.ts). */
  block: string;
  /** Epoch ms after which the composer is given up on. */
  deadline: number;
}

/** How long the composer has to appear after "Add to chat" navigates to it. */
export const DELIVERY_TIMEOUT_MS = 15_000;

type Listener = () => void;

/** The one block on its way in this window; a newer "Add to chat" replaces it. */
export function createDeliveryStore() {
  let pending: Delivery | null = null;
  const listeners = new Set<Listener>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => pending,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(delivery: Delivery) {
      pending = delivery;
      notify();
    },
    /** Clears `delivery` if it is still the pending one. */
    finish(delivery: Delivery) {
      if (pending !== delivery) return;
      pending = null;
      notify();
    },
  };
}

export type DeliveryStore = ReturnType<typeof createDeliveryStore>;

export const windowDeliveries: DeliveryStore = createDeliveryStore();

/** The composer on screen that `target` names, or null. */
export function findComposer(composers: readonly PluginComposerApi[], target: DeliveryTarget): PluginComposerApi | null {
  for (const composer of composers) {
    const scope = composer.scope;
    if (target.kind === "thread" && scope.kind === "thread" && scope.threadId === target.threadId) return composer;
    if (target.kind === "new-thread" && scope.kind === "new-thread" && scope.projectId === target.projectId) return composer;
  }
  return null;
}

/** Adds the block to the composer's draft and focuses it; false when the composer refused. */
export function writeInto(composer: PluginComposerApi, block: string): boolean {
  try {
    composer.replace((current) => appendToDraft(current, block));
    composer.focus();
    return true;
  } catch (cause) {
    console.warn("terminals: could not add the selection to the composer", cause);
    return false;
  }
}

async function fallBackToClipboard(block: string, reason: string): Promise<void> {
  const copied = await experimental_copyToClipboard({ text: block });
  if (copied) toast.error(`${reason} The selection is on the clipboard instead.`);
  else toast.error(`${reason} The selection could not be copied either.`);
}

/** How often a waiting block looks for its composer between renders. */
const POLL_MS = 100;

/**
 * Mounted once per window: writes the pending block into its composer as
 * soon as that composer is on screen. Renders nothing.
 *
 * It looks on every render (a composer came or went, a draft changed) and,
 * while a block waits, every `POLL_MS` too: a composer's scope can change in
 * place — the New thread screen switching to the chosen project — and the
 * handle list need not change with it.
 */
export function ChatDelivery({ store = windowDeliveries, now = Date.now }: { store?: DeliveryStore; now?: () => number }) {
  const composers = useComposers();
  const latest = useRef(composers);
  latest.current = composers;
  const pending = useSyncExternalStore(store.subscribe, store.get, store.get);

  useEffect(() => {
    if (pending === null) return;
    const attempt = (): boolean => {
      if (store.get() !== pending) return true;
      const composer = findComposer(latest.current, pending.target);
      if (composer === null) {
        if (now() < pending.deadline) return false;
        store.finish(pending);
        void fallBackToClipboard(pending.block, "The chat did not open in time.");
        return true;
      }
      store.finish(pending);
      if (!writeInto(composer, pending.block)) void fallBackToClipboard(pending.block, "Could not add the selection to the chat.");
      return true;
    };
    if (attempt()) return;
    const poll = setInterval(() => {
      if (attempt()) clearInterval(poll);
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [composers, pending, store, now]);

  return null;
}
