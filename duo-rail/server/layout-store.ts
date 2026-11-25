// Where the button layout lives: one row in the plugin's key-value store on the bb server.
//
// Up to 0.1.0's pull request it was a JSON string setting, which bb's settings form drew as a raw text
// field. The first read moves a layout saved there into the store and unsets the setting. Pure over
// what it is handed, so it is tested without a bb.
import { defaultLayout, layoutSchema, parseLayout, type Layout } from "../shared/layout";

/** The key-value row; the value is a `Layout` object. */
export const LAYOUT_KEY = "layout";
/** The setting the layout used to be. */
export const LEGACY_LAYOUT_SETTING = "layout";

export interface LayoutStoreDeps {
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  /** The old setting's stored value, if any. */
  readLegacy(): Promise<unknown>;
  /** Unsets the old setting. */
  dropLegacy(): Promise<void>;
  /** Tells every reader the layout changed. */
  changed(): void;
  log: { info(message: string): void; warn(message: string): void };
}

export interface StoredLayout {
  layout: Layout;
  problem: string | null;
}

export function createLayoutStore(deps: LayoutStoreDeps) {
  let migration: Promise<void> | null = null;

  /** Moves a layout saved in the old setting into the store, once per load, and drops the setting. */
  async function migrate(): Promise<void> {
    const legacy = await deps.readLegacy();
    if (legacy === undefined || legacy === null) return;
    // A layout already in the store wins: it was saved after the setting was.
    if ((await deps.kv.get(LAYOUT_KEY)) === undefined) {
      const parsed = parseLayout(legacy);
      // Only a layout the owner saved moves: an empty or broken one means the default, which needs no row.
      if (parsed.problem === null && typeof legacy === "string" && legacy.trim() !== "") {
        await deps.kv.set(LAYOUT_KEY, parsed.layout);
        deps.log.info("Moved the button layout from the old layout setting into the plugin's storage.");
      } else if (parsed.problem !== null) {
        deps.log.warn(`The old layout setting could not be read and was dropped: ${parsed.problem}`);
      }
    }
    await deps.dropLegacy();
  }

  function ensureMigrated(): Promise<void> {
    migration ??= migrate().catch((error: unknown) => {
      // Try again on the next read rather than lose the layout.
      migration = null;
      throw error;
    });
    return migration;
  }

  return {
    async get(): Promise<StoredLayout> {
      await ensureMigrated();
      const stored = await deps.kv.get<unknown>(LAYOUT_KEY);
      if (stored === undefined) return { layout: defaultLayout(), problem: null };
      const parsed = layoutSchema.safeParse(stored);
      if (parsed.success) return { layout: parsed.data, problem: null };
      return { layout: defaultLayout(), problem: `The saved layout could not be read, so the rail shows the default: ${parsed.error.issues[0]?.message ?? "invalid"}` };
    },
    async set(layout: Layout): Promise<Layout> {
      // A save after a failed migration must not be overwritten by it later.
      await ensureMigrated().catch((error: unknown) => deps.log.warn(`Moving the old layout setting failed: ${String(error)}`));
      await deps.kv.set(LAYOUT_KEY, layout);
      deps.changed();
      return layout;
    },
  };
}
