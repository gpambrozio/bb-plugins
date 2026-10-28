/**
 * Copying text through bb's own clipboard writer, `experimental_copyToClipboard`
 * (bb 0.46): native in bb's desktop app, the clipboard bridge in the mobile
 * app, the browser's clipboard in a tab.
 *
 * bb 0.45 has no such writer, and the SDK's shim throws when the app runtime
 * lacks a member, so a throw falls back to `navigator.clipboard` — the plugin
 * keeps `engines.bb >=0.45`.
 */
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";

type Copy = (content: { text: string }) => Promise<boolean>;

/**
 * True when the text was copied; never rejects. Call it straight from the
 * click: Safari writes only within one, and nothing is awaited before either
 * writer is called (the shim's throw is synchronous).
 */
export async function copyText(text: string, copy: Copy = experimental_copyToClipboard): Promise<boolean> {
  try {
    return await copy({ text });
  } catch {
    return copyWithBrowser(text);
  }
}

async function copyWithBrowser(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
