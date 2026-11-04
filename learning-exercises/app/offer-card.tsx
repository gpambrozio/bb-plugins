/**
 * An offer, as the composer banner and the Learning tab show it: one line naming the topic and the cost,
 * Start, Later and Not in this thread, and under More: Run here, Never for this project, and the
 * settings. Nothing is said about the exercise itself, and ignoring it costs nothing.
 *
 * The offer counts toward the caps once it is on screen (`offerSeen`), never before: an offer in a
 * thread nobody looks at expires without counting.
 */
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TRIGGER_LABELS, type Offer, type OfferAnswer } from "../shared/types";
import { errorText, useLearningRpc } from "./data";
import { openSettings } from "./open-settings";

const WHAT_HAPPENED: Record<Offer["trigger"], string> = {
  commit: "You just committed",
  "new-files": "You just added",
  schema: "You just changed a schema:",
  "pr-merged": "Your pull request merged:",
  streak: "You have been at it for a while on",
  manual: "",
};

export function offerSentence(offer: Offer): string {
  return `${WHAT_HAPPENED[offer.trigger]} ${offer.topic}.`.trim();
}

export function OfferCard(props: { offer: Offer; threadId: string; onScreen: boolean; where: "banner" | "tab"; sessionWhere: "fork" | "here" }) {
  const { offer, threadId, onScreen } = props;
  const rpc = useLearningRpc();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<OfferAnswer | null>(null);
  const [more, setMore] = useState(false);
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (!onScreen || offer.seenAt !== null || reported.current === offer.id) return;
    reported.current = offer.id;
    rpc.call("offerSeen", { offerId: offer.id }).catch(() => {
      reported.current = null;
    });
  }, [offer.id, offer.seenAt, onScreen, rpc]);

  const answer = async (choice: OfferAnswer) => {
    setBusy(choice);
    try {
      const { threadId: sessionThread } = await rpc.call("answerOffer", { offerId: offer.id, answer: choice });
      if (sessionThread !== null && sessionThread !== threadId) navigate.toThread(sessionThread);
      if (choice === "never-project") toast("No more offers in this project. Undo it from the Learning tab or the plugin's settings.");
      if (choice === "not-thread") toast("No more offers in this thread. Turn them back on from the thread menu.");
    } catch (error) {
      toast.error(`Learning Exercises: ${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid={`offer-${props.where}`}>
      <div className="flex items-start gap-2">
        <Icon name="Brain" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 leading-snug">
          <span className="font-medium">Learning:</span> {offerSentence(offer)} Want a 10–15 minute exercise on it?{" "}
          <span className="text-muted-foreground">
            {props.sessionWhere === "fork" ? "It runs in a side thread; this one is left alone." : "It runs here, in this thread."}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void answer("start")}>
          {busy === "start" ? "Starting…" : "Start"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void answer("later")}>
          Later
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void answer("not-thread")}>
          Not in this thread
        </Button>
        <Button type="button" size="sm" variant="ghost" aria-expanded={more} aria-label="More choices" onClick={() => setMore((open) => !open)}>
          <Icon name="MoreHorizontal" />
        </Button>
      </div>
      {more && (
        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          {props.sessionWhere === "fork" && (
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void answer("here")}>
              Run it in this thread
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void answer("never-project")}>
            Never for this project
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!openSettings(window)) toast("Learning Exercises' settings are in Settings → Plugins.");
            }}
          >
            Turn off learning offers…
          </Button>
        </div>
      )}
      <span className="sr-only">Offered after a {TRIGGER_LABELS[offer.trigger]}.</span>
    </div>
  );
}
