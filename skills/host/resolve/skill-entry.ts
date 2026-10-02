import type { SkillEntry, SkillSourceKind } from "../../shared/skills";

export { dedupeByName } from "../../shared/skills";
export type { SkillEntry, SkillSource, SkillSourceKind } from "../../shared/skills";

/**
 * A discovered skill with the body of the very bytes discovery validated.
 * `read` serves this body rather than opening the path again, so a file
 * swapped after the scan — for a symlink to something else — is never what
 * it returns. The body stays on the host: `discover` strips it.
 */
export interface ScannedSkill extends SkillEntry {
  body: string;
}

export function makeSkillId(kind: SkillSourceKind, dir: string, name: string): string {
  return `${kind}:${dir}:${name}`;
}
