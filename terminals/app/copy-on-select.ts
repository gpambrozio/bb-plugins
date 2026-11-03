/**
 * bb's own "Copy on select" setting (Settings → General → Terminals), which this page's
 * terminals follow as bb's do.
 *
 * The app SDK reads it as `generalSettings.terminalCopyOnSelect` in
 * `useSdk().system.config()`, and `useSdk().subscribe({ event:
 * "system:config-changed" })` says when bb's settings were saved; the page
 * reads it again then (`reload`, past the freshness window). The event is
 * only a hint — it is lost while the realtime link is down — so the page also
 * reads it when it opens, when the link comes back, when the window comes back
 * to the front, and as a selection starts (at most every few seconds), and a
 * selection uses the latest answer.
 */

/** bb's default for the setting. */
export const COPY_ON_SELECT_DEFAULT = true;

/** A read made less than this long ago is fresh enough for the next selection. */
export const COPY_ON_SELECT_FRESH_MS = 2_000;

export interface AppConfigReader {
  config(): Promise<{ generalSettings: { terminalCopyOnSelect?: boolean } }>;
}

export class CopyOnSelectSetting {
  private value: boolean | null = null;
  private inFlight: Promise<boolean> | null = null;
  private readAt = Number.NEGATIVE_INFINITY;
  /** Counts reads, so an older one that answers late cannot overwrite a newer answer. */
  private reads = 0;
  private warned = false;

  constructor(
    private readonly reader: AppConfigReader,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last value read, or null before the first answer. */
  current(): boolean | null {
    return this.value;
  }

  /** Reads the setting again unless a read is on its way or was made just now. */
  refresh(): Promise<boolean> {
    if (this.inFlight !== null) return this.inFlight;
    if (this.value !== null && this.now() - this.readAt < COPY_ON_SELECT_FRESH_MS) return Promise.resolve(this.value);
    return this.reload();
  }

  /**
   * Reads the setting now, whatever was read before: bb said it changed, so a
   * fresh answer and a read already on its way may both predate the change.
   */
  reload(): Promise<boolean> {
    const id = ++this.reads;
    this.readAt = this.now();
    // A reader that throws instead of rejecting counts as a failed read too.
    const read = new Promise<Awaited<ReturnType<AppConfigReader["config"]>>>((resolve) => resolve(this.reader.config())).then(
      (config) => {
        const value = config.generalSettings.terminalCopyOnSelect ?? COPY_ON_SELECT_DEFAULT;
        if (id === this.reads) this.value = value;
        return this.value ?? value;
      },
      (cause: unknown) => {
        if (!this.warned) {
          this.warned = true;
          console.warn("terminals: could not read bb's Copy on select setting", cause);
        }
        // Keep the last answer; with none yet, bb's default.
        return this.value ?? COPY_ON_SELECT_DEFAULT;
      },
    );
    const tracked: Promise<boolean> = read.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  /**
   * The value for a selection made now: the answer to the read on its way
   * (the one its press started), else the last answer, else a first read.
   */
  resolve(): Promise<boolean> {
    if (this.inFlight !== null) return this.inFlight;
    return this.value !== null ? Promise.resolve(this.value) : this.refresh();
  }
}
