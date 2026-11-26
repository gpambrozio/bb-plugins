// What the owner turns on in Code Mode's settings page: the projects whose new threads start in Code
// Mode, and the machines where Code Mode may run at all. Kept in the plugin's storage rather than in
// bb's settings form, which has no field for a list of projects or machines. Both default to off.
//
// Projects are switched by name, not by bb project id: the same repository is often a separate bb
// project on each machine, or two checkouts on one, all with one name, and the owner wants one switch
// for all of them, which a project added later with that name follows too.
import { z } from "zod";

export const configSchema = z.object({
  /** Project name → new threads in every bb project with that name start in Code Mode. */
  projectNames: z.record(z.string(), z.boolean()),
  /** hostId → Code Mode may run on this machine. */
  hosts: z.record(z.string(), z.boolean()),
});
export type Config = z.infer<typeof configSchema>;

export const EMPTY_CONFIG: Config = { projectNames: {}, hosts: {} };

export function projectDefault(config: Config, projectName: string | null | undefined): boolean {
  return projectName != null && config.projectNames[projectName] === true;
}

export function hostAllowed(config: Config, hostId: string | null | undefined): boolean {
  return hostId != null && config.hosts[hostId] === true;
}
