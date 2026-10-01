import type { SkillSourceKind } from "../../shared/skills";

export { dedupeByName } from "../../shared/skills";
export type { SkillEntry, SkillSource, SkillSourceKind } from "../../shared/skills";

export function makeSkillId(kind: SkillSourceKind, dir: string, name: string): string {
  return `${kind}:${dir}:${name}`;
}
