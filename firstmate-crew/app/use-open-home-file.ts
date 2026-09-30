/**
 * Opens a file of the first mate's home in bb's file preview. The home is the first mate's workspace, so
 * the file is addressed by the first mate thread's environment and a path relative to the home.
 */
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";

import { reportError } from "./notify";

export function useOpenHomeFile(mateThreadId: string): (path: string) => void {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  return useCallback(
    (path: string) => {
      sdk.threads
        .get({ threadId: mateThreadId })
        .then((thread) => {
          if (thread.environmentId === null) throw new Error("The first mate has no workspace to open the file in.");
          const opened = navigate.experimental_openFilePreview({
            target: { kind: "workspace", environmentId: thread.environmentId, path },
            location: null,
          });
          if (!opened) throw new Error(`bb could not open ${path} here.`);
        })
        .catch(reportError);
    },
    [sdk, navigate, mateThreadId],
  );
}
