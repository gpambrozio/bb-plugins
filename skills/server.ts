// skills — the server entry.
//
// Resolves a thread to its provider and environment — or the new-thread
// composer's selection to the project checkout it would start from — asks the
// host entry on
// the environment's machine to scan that provider's skill directories, adds the
// skills bb itself injects into every thread, and the list bb's provider
// reports. Holds no state. See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import { hostContract } from "./shared/host-contract";
import {
  listSkills,
  newThreadWorkspaceFrom,
  readSkill,
  workspaceFrom,
  type SkillsPorts,
  type ThreadWorkspace,
} from "./server/skills";
import type { NewThreadSubject } from "./shared/skills";

export type { RpcContract } from "./shared/contract";

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function threadWorkspace(threadId: string): Promise<ThreadWorkspace> {
    const thread = await bb.sdk.threads.get({ threadId });
    const environment =
      thread.environmentId === null ? null : await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return workspaceFrom(thread, environment);
  }

  async function newThreadWorkspace(subject: NewThreadSubject): Promise<ThreadWorkspace> {
    const [project, environment] = await Promise.all([
      bb.sdk.projects.get({ projectId: subject.projectId }),
      subject.environmentId === null ? null : bb.sdk.environments.get({ environmentId: subject.environmentId }),
    ]);
    return newThreadWorkspaceFrom(subject, project, environment);
  }

  const ports: SkillsPorts = {
    workspaceOf: (subject) =>
      "threadId" in subject ? threadWorkspace(subject.threadId) : newThreadWorkspace(subject.newThread),
    discover: (workspace) =>
      host.call("discover", { provider: workspace.provider, cwd: workspace.cwd }, { hostId: workspace.hostId }),
    readDiscovered: (workspace, skillId) =>
      host.call("read", { provider: workspace.provider, cwd: workspace.cwd, skillId }, { hostId: workspace.hostId }),
    async bbSkills(workspace) {
      const { skills } = await bb.sdk.skills.list(scopeOf(workspace));
      return skills;
    },
    async bbSkillContent(workspace, skillId) {
      const { content } = await bb.sdk.skills.getContent({ ...scopeOf(workspace), skillId, path: "SKILL.md" });
      return content;
    },
    async commands(workspace) {
      // A new thread with no environment yet asks for its checkout's machine,
      // as bb's own `/` menu does in the new-thread composer.
      const routing =
        workspace.environmentId === null ? { hostId: workspace.hostId } : { environmentId: workspace.environmentId };
      const { commands } = await bb.sdk.projects.commands({
        projectId: workspace.projectId,
        provider: workspace.provider,
        ...routing,
      });
      return commands;
    },
  };

  bb.rpc.register(rpcContract, {
    list: (subject) => listSkills(ports, subject),
    read: ({ skillId, ...subject }) => readSkill(ports, subject, skillId),
  });
}

function scopeOf(workspace: ThreadWorkspace) {
  return { projectId: workspace.projectId, environmentId: workspace.environmentId };
}
