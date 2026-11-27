// The reasons Code Mode can't start a thread on a machine, worded once for the dispatch hook's refusal
// and the app. No SDK import: the app bundles this.

export function machineLabel(name: string | null | undefined): string {
  return name?.trim() ? name.trim() : "this machine";
}

export function offOnMachine(name: string | null | undefined): string {
  return `Code Mode is off on ${machineLabel(name)}`;
}

export function notReadyOnMachine(name: string | null | undefined, reason: string): string {
  return `Code Mode's wrapper isn't ready on ${machineLabel(name)}: ${reason.replace(/\.$/, "")}`;
}
