// The RPCs between the app and the server: the button layout, kept in the plugin's own storage on the
// bb server. The rail and the Buttons editor read it with `experimental_useRpcQuery`, which takes the
// contract as a value, so this module must not import the SDK at run time (bb provides the SDK root to
// the server bundle only; app/imports.test.ts checks). `satisfies` gives `defineRpcContract`'s checks.
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { layoutSchema } from "./layout";

/** The tag every layout read carries; the server invalidates it on a write, and every open rail reads again. */
export const LAYOUT_TAG = "layout";

export const rpcContract = {
  /** The saved layout, or the default; `problem` says why a stored one could not be used. */
  "layout.get": {
    input: z.object({}),
    output: z.object({ layout: layoutSchema, problem: z.string().nullable() }),
    tags: () => [LAYOUT_TAG],
  },
  /** Saves a layout; one the rail could not draw is refused with the reason, by the input schema. */
  "layout.set": { input: z.object({ layout: layoutSchema }), output: z.object({ layout: layoutSchema }) },
} satisfies PluginRpcContract;

export type RpcContract = typeof rpcContract;
