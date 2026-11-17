/**
 * The global mute over Herald's master switch (`speak` in the host form; see
 * `shared/mute.ts`). Muting writes the switch off, unmuting writes it on, and
 * a request that changes nothing writes nothing, so a voice hook may repeat it
 * as often as it likes. Requests run one after another in the order they came,
 * so a quick mute then unmute ends unmuted.
 */
export interface SpeakSwitch {
  /** Whether *Speak announcements* is on. */
  get(): Promise<boolean>;
  set(on: boolean): Promise<void>;
}

export interface MuteResult {
  muted: boolean;
  /** False when Herald already was in that state, and nothing was written. */
  changed: boolean;
}

export class GlobalMute {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly speak: SpeakSwitch) {}

  async muted(): Promise<boolean> {
    return !(await this.speak.get());
  }

  set(muted: boolean): Promise<MuteResult> {
    const next = this.chain.then(async () => {
      if ((await this.muted()) === muted) return { muted, changed: false };
      await this.speak.set(!muted);
      return { muted, changed: true };
    });
    // A failed request must not wedge the ones after it.
    this.chain = next.catch(() => {});
    return next;
  }
}
