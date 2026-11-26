import { describe, expect, it } from "vitest";

import { MAX_COMMANDS, MAX_STORED_CHARS, capCommands, createAgentCommands } from "./agent-commands";

function store() {
  const values = new Map<string, unknown>();
  const commands = createAgentCommands({
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => void values.set(key, structuredClone(value)),
    delete: async (key) => void values.delete(key),
    list: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
  });
  return { commands, values };
}

describe("the commands a tab's agent chat ran", () => {
  it("keeps every command of the tab's chat in order, and nothing for another chat", async () => {
    const { commands } = store();
    await Promise.all([commands.append("term_1", "thr_a", "ls", 1), commands.append("term_1", "thr_a", "sudo lsof", 2)]);
    await commands.append("term_2", "thr_b", "pwd", 3);
    expect(await commands.list("term_1", "thr_a")).toEqual([
      { command: "ls", at: 1 },
      { command: "sudo lsof", at: 2 },
    ]);
    expect(await commands.list("term_1", "thr_other")).toEqual([]);
    expect(await commands.list("term_1", null)).toEqual([]);
  });

  it("starts over for a new chat, and forgets a tab's commands when its chat ends", async () => {
    const { commands } = store();
    await commands.append("term_1", "thr_a", "ls", 1);
    await commands.append("term_1", "thr_new", "pwd", 2);
    expect(await commands.list("term_1", "thr_new")).toEqual([{ command: "pwd", at: 2 }]);
    await commands.clear("term_1");
    expect(await commands.list("term_1", "thr_new")).toEqual([]);
  });

  it("keeps only the records of tabs that still have that chat", async () => {
    const { commands, values } = store();
    await commands.append("term_1", "thr_a", "ls", 1);
    await commands.append("term_2", "thr_b", "ls", 1);
    await commands.retain((terminalId, threadId) => terminalId === "term_1" && threadId === "thr_a");
    expect([...values.keys()]).toEqual(["agent-commands:term_1"]);
  });

  it("drops the oldest past a thousand commands or the stored size", () => {
    const many = Array.from({ length: MAX_COMMANDS + 10 }, (_, index) => ({ command: `echo ${index}`, at: index }));
    const capped = capCommands(many);
    expect(capped).toHaveLength(MAX_COMMANDS);
    expect(capped[0]?.command).toBe("echo 10");
    const long = Array.from({ length: 100 }, (_, index) => ({ command: `${index}`.padEnd(4000, "x"), at: index }));
    const fitted = capCommands(long);
    expect(fitted.reduce((sum, entry) => sum + entry.command.length, 0)).toBeLessThanOrEqual(MAX_STORED_CHARS);
    expect(fitted.at(-1)?.at).toBe(99);
  });
});
