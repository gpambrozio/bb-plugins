// The rows of the settings page's two lists: one per machine, and one per project *name*. bb often has
// several projects with one name (the same repository on two machines, or two checkouts on one); the
// owner switches them together, so they share a row (shared/config.ts).

export interface HostLike {
  id: string;
  name: string;
}

export interface ProjectLike {
  name: string;
}

export interface Row {
  /** What the switch is keyed by: a host id, or a project name. */
  key: string;
  label: string;
}

function byLabel(a: Row, b: Row): number {
  return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
}

export function hostRows(hosts: readonly HostLike[]): Row[] {
  const seen = new Set<string>();
  return hosts
    .filter((host) => (seen.has(host.id) ? false : (seen.add(host.id), true)))
    .map((host) => ({ key: host.id, label: host.name }))
    .sort(byLabel);
}

export function projectRows(projects: readonly ProjectLike[]): Row[] {
  const names = new Set(projects.map((project) => project.name));
  return [...names].map((name) => ({ key: name, label: name })).sort(byLabel);
}
