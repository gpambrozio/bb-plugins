/**
 * Which summary helpers this instance of the plugin is responsible for, and
 * what happens to them when it unloads.
 *
 * Unload waits for running summaries to put their helpers away, but only so
 * long (`DRAIN_TIMEOUT_MS`): a spawn or a stop can hang. After that, this
 * instance's `bb.sdk` is about to go stale, so `release()` hands every helper
 * it still owns — and any whose spawn answers later — to the instance that
 * replaces it, which stops and deletes them with a live SDK. Calls that would
 * reach bb after release go the same way instead, and wait until that instance
 * is done — so the summary that owned the helper, and the slot it holds
 * (`slots.ts`), last until the helper is really put away. Nothing is abandoned:
 * whatever no instance receives (the plugin was disabled, not reloaded) is
 * caught by the next load's sweep of leftover helpers.
 */
import type { HelperPort, HelperSpawn } from "./ports";

export class HelperOwnership implements HelperPort {
  private readonly owned = new Set<string>();
  private readonly handedOver = new Map<string, Promise<void>>();
  private released = false;

  constructor(
    private readonly port: () => HelperPort,
    private readonly handOver: (helperId: string) => Promise<void>,
  ) {}

  /** Whether this instance spawned the helper and has not put it away. */
  owns(helperId: string): boolean {
    return this.owned.has(helperId);
  }

  async spawn(args: HelperSpawn): Promise<string> {
    const helperId = await this.port().spawn(args);
    this.owned.add(helperId);
    if (this.released) void this.give(helperId);
    return helperId;
  }

  async stop(helperId: string): Promise<void> {
    if (this.released) return this.give(helperId);
    await this.port().stop(helperId);
  }

  async archive(helperId: string): Promise<void> {
    if (this.released) return this.give(helperId);
    await this.port().archive(helperId);
    this.owned.delete(helperId);
  }

  async delete(helperId: string): Promise<void> {
    if (this.released) return this.give(helperId);
    await this.port().delete(helperId);
    this.owned.delete(helperId);
  }

  listLeftovers(createdBefore: number): Promise<string[]> {
    return this.port().listLeftovers(createdBefore);
  }

  /** On unload, once draining is over: hands over every helper still owned, and every later one. */
  release(): void {
    this.released = true;
    for (const helperId of [...this.owned]) void this.give(helperId);
  }

  /** Hands the helper over once, and resolves when the taking instance has put it away. */
  private give(helperId: string): Promise<void> {
    let given = this.handedOver.get(helperId);
    if (given === undefined) {
      this.owned.delete(helperId);
      given = this.handOver(helperId);
      this.handedOver.set(helperId, given);
    }
    return given;
  }
}
