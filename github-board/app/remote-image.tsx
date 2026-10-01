/**
 * An image out of a body or a comment. A GitHub-hosted one is fetched through
 * the server, which holds the token a private repository's attachment needs;
 * any other host waits for a tap, because loading it tells that host who is
 * reading and when. `app/image-gate.ts` makes both decisions.
 */
import { useEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { imageOrigin, startImageLoad, type LoadedImage } from "./image-gate";
import { isOpenableLink } from "./link";
import { useBoardRpc } from "./state";

/** Fetched images, by URL, so reopening a panel shows them without asking again. */
const cachedImages = new Map<string, LoadedImage>();
const IMAGE_CACHE_ENTRIES = 24;

function remember(url: string, image: LoadedImage): void {
  cachedImages.set(url, image);
  if (cachedImages.size > IMAGE_CACHE_ENTRIES) {
    const oldest = cachedImages.keys().next().value;
    if (oldest !== undefined) cachedImages.delete(oldest);
  }
}

/** Loads a URI in an off-screen image to learn its size, so the frame is sized before it paints. */
function measure(uri: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ uri, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("The image could not be loaded."));
    image.src = uri;
  });
}

export function RemoteImage({ url, alt }: { url: string; alt: string }) {
  const rpc = useBoardRpc();
  const navigate = useBbNavigate();
  const origin = useMemo(() => imageOrigin(url), [url]);
  const [requested, setRequested] = useState(false);
  const [loaded, setLoaded] = useState<LoadedImage | null>(() => cachedImages.get(url) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loaded !== null) return;
    const pending = startImageLoad(url, origin, requested, {
      viaServer: (target) => rpc.call("loadImage", { url: target }).then((result) => result.dataUrl),
      measure,
    });
    if (pending === null) return;
    let live = true;
    pending.then(
      (image) => {
        remember(url, image);
        if (live) setLoaded(image);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [url, origin, requested, loaded, rpc]);

  const label = alt.trim() === "" ? "image" : alt;
  const openable = isOpenableLink(url);

  if (loaded !== null) {
    return (
      <button
        type="button"
        className="block max-w-full cursor-pointer"
        title={openable ? "Open the original" : undefined}
        onClick={() => {
          if (openable) navigate.openUrl(url);
        }}
      >
        <img
          src={loaded.uri}
          alt={label}
          className="max-h-[480px] max-w-full rounded-md border border-border object-contain"
          style={{ aspectRatio: `${loaded.width} / ${loaded.height}` }}
        />
      </button>
    );
  }

  if (failed || origin.kind === "unknown") {
    return <span className="text-sm text-muted-foreground">[image: {label}]</span>;
  }

  if (origin.kind === "external" && !requested) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        <span>
          Image from <span className="font-medium text-foreground">{origin.host}</span>
          {alt.trim() === "" ? null : ` — ${alt}`}
        </span>
        <Button size="sm" variant="outline" onClick={() => setRequested(true)}>
          Load image
        </Button>
      </div>
    );
  }

  return <div className="h-24 w-full animate-pulse rounded-md bg-muted" aria-label={`Loading ${label}`} />;
}
