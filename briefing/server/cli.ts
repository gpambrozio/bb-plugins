/**
 * `bb briefing` — the whole session-start briefing in one call, and `bb briefing thread <id>` for one
 * thread in more depth. Text by default, sized for a voice tool's 4,000-character result; `--json` for
 * the data. Both only read, and neither depends on which thread (if any) the caller is in.
 */
import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";

import { gatherBriefing, gatherThread } from "./gather";
import type { BriefingPorts } from "./ports";
import { renderBriefing, renderThread } from "./render";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(`The briefing could not be read: ${reason(error)}`, { code: "failed" });
  }
}

const json = { type: "boolean", description: "Print the data as JSON instead of the text: for scripts, with no size limit" } as const;

export function briefingCli(portsFor: (signal: AbortSignal | undefined) => BriefingPorts): PluginCliRegistration {
  return defineCli({
    name: "briefing",
    summary: "Where every root thread and FirstMate's tasks stand, in one read",
    description:
      "With no command, prints every root thread (not archived): its title, project, status, opening message, latest user message, latest agent reply and blocked sub-threads, each project's description, and FirstMate's tasks by state. The text fits in 4,000 characters; when it would not, detail is dropped and a 'Left out to fit' line says what. Read-only.",
    root: cliCommand({
      summary: "Brief on every root thread and FirstMate's tasks",
      options: { json },
      run: (input, ctx) =>
        guarded(async () => {
          const briefing = await gatherBriefing(portsFor(ctx.signal));
          const stdout = input.options.json ? `${JSON.stringify(briefing, null, 2)}\n` : `${renderBriefing(briefing)}\n`;
          return { exitCode: 0, stdout };
        }),
    }),
    commands: {
      thread: cliCommand({
        summary: "One thread in depth: its opening, last user messages, latest reply and sub-threads",
        positionals: [{ name: "id", description: "The thread's id (thr_…)", required: true }],
        options: { json },
        run: (input, ctx) =>
          guarded(async () => {
            const id = input.positionals.id.trim();
            const detail = await gatherThread(portsFor(ctx.signal), id);
            if (detail === null) throw new PluginCliError(`No thread ${id}.`, { code: "unknown_thread" });
            const stdout = input.options.json ? `${JSON.stringify(detail, null, 2)}\n` : `${renderThread(detail)}\n`;
            return { exitCode: 0, stdout };
          }),
      }),
    },
  });
}
