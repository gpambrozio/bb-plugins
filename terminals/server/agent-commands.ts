/**
 * The commands a tab's agent chat typed into that tab, kept with the tab in
 * plugin storage so every window and a reload see them. A tab's record
 * belongs to one chat (its thread id): a command from another chat starts it
 * over, and it is cleared when the chat ends for the tab (the owner starts a
 * new chat, or closes the tab).
 *
 * One kv value per tab, held under the kv limit (256 KB) by dropping the
 * oldest commands past `MAX_COMMANDS` or `MAX_STORED_CHARS`.
 */
import { z } from "zod";

/** Generous: a long debugging session. */
export const MAX_COMMANDS = 1000;
/** What one tab's record may take, in characters of command text, well under the kv limit. */
export const MAX_STORED_CHARS = 150_000;

export const AgentCommandSchema = z.object({ command: z.string(), at: z.number() });
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

const RecordSchema = z.object({ threadId: z.string(), commands: z.array(AgentCommandSchema) });
type CommandsRecord = z.infer<typeof RecordSchema>;

export interface CommandsKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const PREFIX = "agent-commands:";

/** The newest commands that fit both limits, oldest first. */
export function capCommands(commands: readonly AgentCommand[]): AgentCommand[] {
  const kept: AgentCommand[] = [];
  let chars = 0;
  for (let index = commands.length - 1; index >= 0 && kept.length < MAX_COMMANDS; index -= 1) {
    const entry = commands[index]!;
    chars += entry.command.length;
    if (chars > MAX_STORED_CHARS && kept.length > 0) break;
    kept.push(entry);
  }
  return kept.reverse();
}

export function createAgentCommands(kv: CommandsKv) {
  // Every change waits for the one before, as the link store's do.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };
  const read = async (terminalId: string): Promise<CommandsRecord | null> => {
    const parsed = RecordSchema.safeParse(await kv.get(PREFIX + terminalId));
    return parsed.success ? parsed.data : null;
  };
  return {
    /** The commands `threadId` typed into the tab, oldest first; none for another chat's record. */
    async list(terminalId: string, threadId: string | null): Promise<AgentCommand[]> {
      if (threadId === null) return [];
      const record = await read(terminalId);
      return record !== null && record.threadId === threadId ? record.commands : [];
    },
    /** Records that `threadId` typed `command` into the tab; a different chat's commands are dropped first. */
    append(terminalId: string, threadId: string, command: string, at: number): Promise<void> {
      return serial(async () => {
        const record = await read(terminalId);
        const earlier = record !== null && record.threadId === threadId ? record.commands : [];
        await kv.set(PREFIX + terminalId, { threadId, commands: capCommands([...earlier, { command, at }]) });
      });
    },
    /** The tab's chat ended for it: forget its commands. */
    clear(terminalId: string): Promise<void> {
      return serial(() => kv.delete(PREFIX + terminalId));
    },
    /** Forgets the records of tabs that no longer have a chat. */
    retain(isLinked: (terminalId: string, threadId: string) => boolean): Promise<void> {
      return serial(async () => {
        for (const key of await kv.list(PREFIX)) {
          const terminalId = key.slice(PREFIX.length);
          const record = await read(terminalId);
          if (record === null || !isLinked(terminalId, record.threadId)) await kv.delete(key);
        }
      });
    },
  };
}

export type AgentCommands = ReturnType<typeof createAgentCommands>;
