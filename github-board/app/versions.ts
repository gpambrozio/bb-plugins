/**
 * Which answer wins when several can be in flight at once: a fetch, a save, a
 * local change and a pushed signal all write the same value, and their answers
 * arrive in whatever order the network delivers them.
 *
 * The rule, for every one of them: take a ticket when it **starts**; adopt its
 * value only if no later-started source has been adopted already; show its
 * failure only if nothing at all has started since it did. So a fetch or a save
 * that started before a pushed change can neither put the older value back nor
 * cover the newer one with its error, while the newest request still reports
 * that it failed.
 *
 * A pushed signal starts and lands at once, so it always wins over whatever was
 * still in flight when it arrived — pushes reach every window in the order the
 * server stored them, which makes the last one the server's own state.
 */
export class Versions {
  private issued = 0;
  private adopted = 0;

  /** A ticket for a source that starts now. */
  begin(): number {
    this.issued += 1;
    return this.issued;
  }

  /** Whether a value from `ticket` may be adopted; records it when it may. */
  adopt(ticket: number): boolean {
    if (ticket <= this.adopted) return false;
    this.adopted = ticket;
    return true;
  }

  /** Whether a failure from `ticket` may be shown: nothing has started since it did. */
  mayFail(ticket: number): boolean {
    return ticket === this.issued;
  }
}
