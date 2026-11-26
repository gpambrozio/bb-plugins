// The per-project and per-machine switches (shared/config.ts), one row in the plugin's key-value store,
// cached in memory: the dispatch hook reads them under bb's server-wide dispatch lock, so they must not
// cost a storage read per send.
//
// Before 0.1.0 shipped, a build of it switched projects by id (`projects`). The first read turns those
// into names, by the projects' current names, and drops the ids.
import { z } from "zod";

import { configSchema, EMPTY_CONFIG, type Config } from "../shared/config";

export const CONFIG_KEY = "config";

const storedSchema = z.object({
  projectNames: z.record(z.string(), z.boolean()).optional(),
  /** The pre-release per-id switches. */
  projects: z.record(z.string(), z.boolean()).optional(),
  hosts: z.record(z.string(), z.boolean()).optional(),
});

export interface ConfigStoreDeps {
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  /** The current name of each of these projects; an id bb no longer knows is missing. */
  projectNames(projectIds: readonly string[]): Promise<Map<string, string>>;
  changed(): void;
  log: { info(message: string): void; warn(message: string): void };
}

export function createConfigStore(deps: ConfigStoreDeps) {
  let cached: Config | null = null;
  let loading: Promise<Config> | null = null;
  /** Writes in order, each over the one before. */
  let writes: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Config> {
    const stored = await deps.kv.get<unknown>(CONFIG_KEY);
    if (stored === undefined) return EMPTY_CONFIG;
    const parsed = storedSchema.safeParse(stored);
    if (!parsed.success) {
      deps.log.warn("Code Mode's saved switches could not be read; every project and machine is off until they are set again.");
      return EMPTY_CONFIG;
    }
    const config: Config = { projectNames: { ...parsed.data.projectNames }, hosts: { ...parsed.data.hosts } };
    const legacy = Object.entries(parsed.data.projects ?? {}).filter(([, on]) => on).map(([projectId]) => projectId);
    if (parsed.data.projects !== undefined) {
      const names = legacy.length > 0 ? await deps.projectNames(legacy) : new Map<string, string>();
      for (const projectId of legacy) {
        const name = names.get(projectId);
        if (name) config.projectNames[name] = true;
      }
      await deps.kv.set(CONFIG_KEY, configSchema.parse(config));
      deps.log.info(`Moved ${names.size} project switch(es) from project ids to project names.`);
    }
    return configSchema.parse(config);
  }

  function get(): Promise<Config> {
    if (cached) return Promise.resolve(cached);
    loading ??= load()
      .then((config) => (cached = config))
      .finally(() => {
        loading = null;
      });
    return loading;
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

  function setSwitches(map: Record<string, boolean>, keys: readonly string[], on: boolean): Record<string, boolean> {
    const copy = { ...map };
    for (const key of keys) {
      if (on) copy[key] = true;
      else delete copy[key];
    }
    return copy;
  }

  return {
    get,
    setProjectNames: (names: readonly string[], on: boolean) => update((config) => ({ ...config, projectNames: setSwitches(config.projectNames, names, on) })),
    setHosts: (hostIds: readonly string[], on: boolean) => update((config) => ({ ...config, hosts: setSwitches(config.hosts, hostIds, on) })),
  };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;
