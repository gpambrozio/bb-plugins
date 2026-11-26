// The one call the server makes to the host entry on a machine: write the wrapper there and say where
// its launcher is. No SDK import at run time, like the app's contract.
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const installResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type InstallResult = z.infer<typeof installResultSchema>;

export const hostContract = {
  install: { input: z.object({}), output: installResultSchema, experimental_retryable: true },
} satisfies PluginRpcContract;
