/**
 * Delivers a card picked for a thread whose chat was not on screen (see
 * `pending-add.ts`): once that thread's composer is on screen, the card goes
 * after its draft and the caret follows, as for a chat that was already open.
 * Mounted once per window in the app overlay, and it subscribes to the
 * composers only while a card is pending, since `useComposers()` re-renders on
 * every keystroke in any draft. A card past its deadline is never written,
 * even when its composer turns up before the timer fires.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useComposers } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { addCardToComposer } from "./add-to-chat";
import { pendingAdds, type PendingAdd, type PendingAdds } from "./pending-add";
import { errorText } from "./state";

export function PendingAddToChat({ store = pendingAdds }: { store?: PendingAdds }) {
  const pending = useSyncExternalStore(store.subscribe, store.current, store.current);
  return pending === null ? null : <Deliver key={pending.id} pending={pending} store={store} />;
}

function Deliver({ pending, store }: { pending: PendingAdd; store: PendingAdds }) {
  const composers = useComposers();
  const target = composers.find(
    (composer) => composer.scope.kind === "thread" && composer.scope.threadId === pending.threadId,
  );

  useEffect(() => {
    if (target === undefined || store.take(pending.id) === null) return;
    if (Date.now() >= pending.deadline) {
      notOpened(pending);
      return;
    }
    try {
      addCardToComposer(target, pending.item, pending.column);
    } catch (cause) {
      toast.error(`Could not add to chat: ${errorText(cause)}`);
    }
  }, [target, pending, store]);

  useEffect(() => {
    const timer = setTimeout(
      () => {
        if (store.take(pending.id) !== null) notOpened(pending);
      },
      Math.max(0, pending.deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pending, store]);

  return null;
}

function notOpened(pending: PendingAdd) {
  toast.error(`Could not add to chat: “${pending.title}” did not open.`);
}
