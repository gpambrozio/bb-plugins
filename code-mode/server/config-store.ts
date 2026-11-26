// The per-project and per-machine switches (shared/config.ts), one row in the plugin's key-value store,
// cached in memory: the dispatch hook reads them under bb's server-wide dispatch lock, so they must not
// cost a storage read per send.
import { configSchema, EMPTY_CONFIG, type Config } from "../shared/config";

export const CONFIG_KEY = "config";

export interface ConfigStoreDeps {
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  changed(): void;
  log: { warn(message: string): void };
}

export function createConfigStore(deps: ConfigStoreDeps) {
  let cached: Config | null = null;
  /** Writes in order, each over the one before. */
  let writes: Promise<unknown> = Promise.resolve();

  async function get(): Promise<Config> {
    if (cached) return cached;
    const stored = await deps.kv.get<unknown>(CONFIG_KEY);
    if (stored === undefined) return (cached = EMPTY_CONFIG);
    const parsed = configSchema.safeParse(stored);
    if (!parsed.success) {
      deps.log.warn("Code Mode's saved switches could not be read; every project and machine is off until they are set again.");
      return (cached = EMPTY_CONFIG);
    }
    return (cached = parsed.data);
  }

  function update(change: (config: Config) => Config): Promise<Config> {
    const next = writes.then(async () => {
      const updated = change(await get());
      await deps.kv.set(CONFIG_KEY, updated);
      cached = updated;
      deps.changed();
      return updated;
    });
    writes = next.catch(() => undefined);
    return next;
  }

  function setSwitch(map: Record<string, boolean>, id: string, on: boolean): Record<string, boolean> {
    const copy = { ...map };
    if (on) copy[id] = true;
    else delete copy[id];
    return copy;
  }

  return {
    get,
    setProject: (projectId: string, on: boolean) => update((config) => ({ ...config, projects: setSwitch(config.projects, projectId, on) })),
    setHost: (hostId: string, on: boolean) => update((config) => ({ ...config, hosts: setSwitch(config.hosts, hostId, on) })),
  };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;
