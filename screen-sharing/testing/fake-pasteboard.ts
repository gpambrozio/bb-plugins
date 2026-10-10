/**
 * Test support: a Mac's pasteboard as `pbpaste`, `pbcopy` and the change count
 * would show it, in memory, so no test touches this machine's real clipboard.
 */
import type { PasteboardCommands } from "../host/pasteboard";

export class FakePasteboardCommands implements PasteboardCommands {
  platform: NodeJS.Platform = "darwin";
  text = "";
  changes = 1;
  fullNameCalls = 0;

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
    return this.changes;
  }

  async readText(): Promise<Buffer> {
    return Buffer.from(this.text, "utf8");
  }

  async writeText(text: string): Promise<void> {
    this.copy(text);
  }

  /** Someone copies on the Mac. */
  copy(text: string): void {
    this.text = text;
    this.changes++;
  }
}
