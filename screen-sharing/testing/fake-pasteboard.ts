/**
 * Test support: a Mac's pasteboard as the plugin's JXA scripts see it, in
 * memory, so no test touches this machine's real clipboard. `copy` is someone
 * copying on the Mac; `copyPicture` leaves no plain text; `beforeChangeCount`
 * runs just before a count is sampled, to interleave a copy.
 */
import type { PasteboardCommands, PasteboardText } from "../host/pasteboard";
import { MAX_CLIPBOARD_BYTES } from "../shared/channels";

export class FakePasteboardCommands implements PasteboardCommands {
  platform: NodeJS.Platform = "darwin";
  /** The plain-text flavor; null for a pasteboard without one (a picture). */
  text: string | null = "";
  changes = 1;
  fullNameCalls = 0;
  beforeChangeCount: (() => void) | null = null;

  constructor(
    private readonly user = "ci",
    private readonly full: string | null = "CI Bot",
  ) {}

  userName(): string {
    return this.user;
  }

  async fullName(): Promise<string | null> {
    this.fullNameCalls++;
    return this.full;
  }

  async changeCount(): Promise<number> {
    this.beforeChangeCount?.();
    return this.changes;
  }

  async readText(): Promise<PasteboardText> {
    if (this.text !== null && Buffer.byteLength(this.text, "utf8") > MAX_CLIPBOARD_BYTES) {
      return { changeCount: this.changes, text: null, tooLarge: true };
    }
    return { changeCount: this.changes, text: this.text, tooLarge: false };
  }

  async writeText(text: string): Promise<number> {
    this.copy(text);
    return this.changes;
  }

  /** Someone copies on the Mac. */
  copy(text: string): void {
    this.text = text;
    this.changes++;
  }

  /** Someone copies a picture on the Mac: no plain text. */
  copyPicture(): void {
    this.text = null;
    this.changes++;
  }
}
