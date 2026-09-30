import { toast } from "sonner";

/**
 * The sentence a failure is worth showing. A plugin RPC that fails reaches the app as an `Error` whose
 * message is the handler's own sentence, so it is shown as-is.
 */
export function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function reportError(caught: unknown): void {
  toast.error(errorText(caught));
}
