// What the owner turns on in Code Mode's settings page: the projects whose new threads start in Code
// Mode, and the machines where Code Mode may run at all. Kept in the plugin's storage rather than in
// bb's settings form, which has no field for a list of projects or machines. Both default to off.
import { z } from "zod";

export const configSchema = z.object({
  /** projectId → new threads there start in Code Mode. */
  projects: z.record(z.string(), z.boolean()),
  /** hostId → Code Mode may run on this machine. */
  hosts: z.record(z.string(), z.boolean()),
});
export type Config = z.infer<typeof configSchema>;

export const EMPTY_CONFIG: Config = { projects: {}, hosts: {} };

export function projectDefault(config: Config, projectId: string): boolean {
  return config.projects[projectId] === true;
}

export function hostAllowed(config: Config, hostId: string | null | undefined): boolean {
  return hostId != null && config.hosts[hostId] === true;
}
