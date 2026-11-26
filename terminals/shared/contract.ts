/**
 * The RPC contract between the app and the server. The app imports this file
 * as a type only: it imports `defineRpcContract` from the SDK root, which only
 * the server bundle has (see app/imports.test.ts).
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { MAX_INSTRUCTIONS_LENGTH } from "./agent";
import { HostChoiceSchema, ListedTabSchema, TabViewSchema } from "./tabs";

const Empty = z.object({});
/** The bounds bb's own terminal endpoint accepts. */
const Cols = z.number().int().min(1).max(500);
const Rows = z.number().int().min(1).max(200);

export const rpcContract = defineRpcContract({
  /** The machines "+" can open a terminal on, the server's own first. */
  hosts: { input: Empty, output: z.object({ hosts: z.array(HostChoiceSchema) }) },
  /** Every open tab, in the order the strip shows them, with where its shell is. */
  list: { input: Empty, output: z.object({ tabs: z.array(ListedTabSchema) }) },
  /** Opens a shell in the home directory of `hostId`, as a new tab at the end. */
  open: { input: z.object({ hostId: z.string().min(1), cols: Cols, rows: Rows }), output: TabViewSchema },
  /**
   * Names the tab, for every client. The name is trimmed; an empty one, or
   * null, brings back the default title.
   */
  rename: { input: z.object({ terminalId: z.string().min(1), name: z.string().max(1000).nullable() }), output: Empty },
  /**
   * Moves the tab to where `toTerminalId` is (after it when moving right,
   * before it when moving left), for every client. Moving a tab that is gone,
   * or onto one, changes nothing.
   */
  move: { input: z.object({ terminalId: z.string().min(1), toTerminalId: z.string().min(1) }), output: Empty },
  /** Closes the tab and ends its shell. Closing a tab that is already gone succeeds. */
  close: { input: z.object({ terminalId: z.string().min(1) }), output: Empty },
  /**
   * Starts the tab's helper thread from the agent panel's new-thread composer
   * (`request` is its `NewThreadRequest`, forwarded to `threads.spawn`),
   * replacing the tab's old one. Only that thread gets the tools that read
   * and type into the tab.
   */
  startAgent: {
    input: z.object({ terminalId: z.string().min(1), request: z.record(z.string(), z.unknown()) }),
    output: z.object({ threadId: z.string() }),
  },
  /** Sends `text` to the tab's helper thread, as the user. Fails when the tab has none, or it was archived. */
  askAgent: {
    input: z.object({ terminalId: z.string().min(1), text: z.string().min(1).max(200_000) }),
    output: z.object({ threadId: z.string() }),
  },
  /** Lets go of the tab's helper thread: it keeps its chat, and loses the tab's tools. */
  forgetAgent: { input: z.object({ terminalId: z.string().min(1) }), output: Empty },
  /** The owner's instructions text for a tab's agent; null means the built-in one. */
  agentInstructions: { input: Empty, output: z.object({ text: z.string().nullable() }) },
  /**
   * Saves the owner's instructions text for new agent chats. Null, a blank
   * text, or the built-in text itself goes back to the built-in one.
   */
  setAgentInstructions: {
    input: z.object({ text: z.string().max(MAX_INSTRUCTIONS_LENGTH).nullable() }),
    output: z.object({ text: z.string().nullable() }),
  },
});

export type RpcContract = typeof rpcContract;
