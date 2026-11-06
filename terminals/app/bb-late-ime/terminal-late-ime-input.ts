/**
 * bb's fix for text an iOS keyboard (the system Pinyin keyboard, and other
 * input methods that commit late) inserts after xterm has stopped listening
 * for it, copied from bb so the Terminals page's xterm gets it too. iOS
 * commits a candidate with a keyCode-229 `keydown`, inserts the text about
 * 25 ms later, and only then fires `keyup`; xterm's own 229 check runs before
 * the insertion and then skips the `input` event, so `onData` never sees the
 * text. Install it right after `terminal.open()`. Source: get-bb/bb at
 * desktop-v0.49.0 (commit 7b26cae79ec978fafd0a5db0e8517e94f12eb8f4),
 * apps/app/src/components/thread/terminal/terminal-late-ime-input.ts, from
 * get-bb/bb#6815. MIT licence, notice in ./LICENSE. Unchanged below this
 * comment.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";

const IME_PROCESS_KEY_CODE = 229;

interface PendingImeKey {
  dataSent: boolean;
  xtermCheckDone: boolean;
}

export function forwardLateImeInput(
  terminal: Pick<Terminal, "input" | "onData" | "textarea">,
): IDisposable {
  const textarea = terminal.textarea;
  if (!textarea) {
    return { dispose: () => undefined };
  }
  let pending: PendingImeKey | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.keyCode !== IME_PROCESS_KEY_CODE || event.isComposing) {
      pending = null;
      return;
    }
    const key: PendingImeKey = { dataSent: false, xtermCheckDone: false };
    pending = key;
    const timer = setTimeout(() => {
      timers.delete(timer);
      key.xtermCheckDone = true;
    }, 0);
    timers.add(timer);
  };
  const handleCompositionStart = () => {
    pending = null;
  };
  const handleInput = (event: Event) => {
    const key = pending;
    if (
      key === null ||
      !(event instanceof InputEvent) ||
      event.inputType !== "insertText" ||
      event.isComposing ||
      !event.data
    ) {
      return;
    }
    pending = null;
    if (key.xtermCheckDone && !key.dataSent) {
      terminal.input(event.data);
    }
  };
  const dataSubscription = terminal.onData(() => {
    if (pending !== null) {
      pending.dataSent = true;
    }
  });

  textarea.addEventListener("keydown", handleKeyDown, true);
  textarea.addEventListener("compositionstart", handleCompositionStart, true);
  textarea.addEventListener("input", handleInput, true);
  return {
    dispose: () => {
      textarea.removeEventListener("keydown", handleKeyDown, true);
      textarea.removeEventListener(
        "compositionstart",
        handleCompositionStart,
        true,
      );
      textarea.removeEventListener("input", handleInput, true);
      dataSubscription.dispose();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      pending = null;
    },
  };
}
