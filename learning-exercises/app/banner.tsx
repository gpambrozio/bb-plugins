/**
 * The offer above a thread's composer (feature #2). It shows only while the thread is idle and has a
 * live offer, so it never competes with a running turn, and it renders nothing otherwise. No form is
 * opened and nothing is written into the transcript: an offer costs nothing to ignore.
 */
import { useComposer } from "@get-bb/plugin-sdk/app";

import { useSidebarThread, useThreadView } from "./data";
import { OfferCard } from "./offer-card";

export function OfferBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const row = useSidebarThread(threadId);
  const idle = row !== undefined && row.status === "idle" && !row.hasPendingInteraction;
  const view = useThreadView(threadId, idle);
  const offer = view.data?.offer ?? null;
  if (threadId === null || !idle || offer === null || view.data === undefined) return null;
  return <OfferCard offer={offer} threadId={threadId} onScreen where="banner" sessionWhere={view.data.sessionWhere} />;
}
