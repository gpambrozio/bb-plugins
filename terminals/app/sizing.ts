/**
 * Who decides a shell's size when several windows show it.
 *
 * bb 0.48.1 lets only the socket that attached last resize a terminal and
 * drops the others' resize messages without a word, and this plugin keeps a
 * tab's socket open while its page is away. So the socket is not used to
 * resize. Instead the window the user is using — the one that shows the tab
 * and is shown, resized, focused or typed in — asks bb through
 * `terminals.resize`, which any client may call, and every window draws the
 * shell at the size bb reports (`session-updated`), whichever window set it.
 * A window that is not in use never asks, so two windows cannot fight; the
 * last one used wins, as in tmux.
 *
 * Plain logic over injected functions, tested in sizing.test.ts.
 */

export interface Size {
  cols: number;
  rows: number;
}

export interface SizingOptions {
  /** The size this window's terminal is drawn at now. */
  localSize(): Size;
  /** Redraws this window's terminal at `size`. */
  resizeLocal(size: Size): void;
  /** Asks bb to size the shell (`terminals.resize`); rejects when bb cannot, such as while the machine is offline. */
  claim(size: Size): Promise<void>;
  warn(message: string): void;
}

/** Remembered sizes this window asked for, at most. */
const MAX_REMEMBERED = 16;

export function sameSize(a: Size | null | undefined, b: Size | null | undefined): boolean {
  return a != null && b != null && a.cols === b.cols && a.rows === b.rows;
}

export class TerminalSizing {
  private readonly options: SizingOptions;
  /** The shell's size as bb last reported it; null before the first report. */
  private session: Size | null = null;
  /** The size to ask bb for next; null when nothing is waiting. */
  private wanted: Size | null = null;
  private inFlight = false;
  /**
   * Sizes this window asked for whose report from bb has not been seen as
   * someone else's: their reports must not undo a newer size this window has
   * already drawn (a window being resized asks for several in a row).
   */
  private asked: Size[] = [];

  constructor(options: SizingOptions) {
    this.options = options;
  }

  /** The shell's size as bb last reported it. */
  get current(): Size | null {
    return this.session;
  }

  /** Whether this window draws the shell at a size other than bb's. */
  get differs(): boolean {
    return this.session !== null && !sameSize(this.session, this.options.localSize());
  }

  /** This window is in use and its view fits `size`: draw it so, and have the shell take it. */
  fitted(size: Size): void {
    if (!sameSize(this.options.localSize(), size)) this.options.resizeLocal(size);
    // Already what the shell has, or what this window is about to give it.
    const target = this.wanted ?? (this.inFlight ? this.asked.at(-1) : this.session);
    if (sameSize(target, size)) return;
    this.wanted = size;
    void this.send();
  }

  /** bb reports the shell's size (`attached` or `session-updated`). */
  sessionChanged(size: Size): void {
    this.session = size;
    if (this.asked.some((entry) => sameSize(entry, size))) {
      // This window's own request landing; its newest size is drawn already.
      if (!this.driving && sameSize(this.asked.at(-1), size)) this.asked = [];
      return;
    }
    // Another window sized the shell: draw what the shell really has.
    this.asked = [];
    if (!sameSize(this.options.localSize(), size)) this.options.resizeLocal(size);
  }

  private get driving(): boolean {
    return this.inFlight || this.wanted !== null;
  }

  private async send(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.wanted !== null) {
        const size = this.wanted;
        this.wanted = null;
        this.asked = [...this.asked, size].slice(-MAX_REMEMBERED);
        try {
          await this.options.claim(size);
        } catch (error) {
          // The next fit asks again; meanwhile the view shows what it has.
          this.asked = this.asked.filter((entry) => entry !== size);
          this.options.warn(`could not resize the shell to ${size.cols}×${size.rows}: ${String(error)}`);
        }
      }
    } finally {
      this.inFlight = false;
    }
    if (sameSize(this.session, this.asked.at(-1))) this.asked = [];
  }
}
