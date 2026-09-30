/**
 * What server code logs through. It is bb's plugin logger (`bb.log`), passed in, so a failure reaches
 * `bb plugin logs firstmate` — `console` output does not — and a test can read what was logged.
 */
import type { PluginLogger } from "@get-bb/plugin-sdk";

export type Log = Pick<PluginLogger, "warn" | "error">;

/** An error as one line of a log message. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
