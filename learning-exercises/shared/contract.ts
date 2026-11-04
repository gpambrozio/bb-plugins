/**
 * The RPCs between the app and the server. The server registers handlers for it (`server.ts`); the app
 * reads through `experimental_useRpcQuery`, which takes the contract as a value, and writes through
 * `useRpc<typeof rpcContract>()`. So this module must not import the SDK at run time: bb provides the SDK
 * root to the server bundle only, and a git install builds the app without it. `satisfies` gives the
 * checks `defineRpcContract` would.
 *
 * Every read carries `LEARNING_TAG`; the server invalidates it whenever an offer or a session changes,
 * and every open banner, tab and menu reads again.
 */
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { ExerciseSchema, OfferAnswerSchema, SessionSchema, ThreadViewSchema, TopicChoiceSchema, TriggerKindSchema, RefsSchema } from "./types";

export const LEARNING_TAG = "learning";

const ThreadRef = z.object({ threadId: z.string().min(1) });
const SessionRef = z.object({ sessionId: z.string().min(1) });
const Done = z.null();
const tags = () => [LEARNING_TAG];

/** At most this many threads per `threadOffers` read. */
export const THREAD_OFFERS_BATCH_MAX = 200;

export const rpcContract = {
  /** The banner's and the tab's view of one thread. */
  threadView: { input: ThreadRef, output: ThreadViewSchema, tags },
  /** The tab's lists for the thread's project: paused sessions and previous ones, newest first. */
  projectSessions: {
    input: ThreadRef.extend({ limit: z.number().int().min(1).max(200).optional() }),
    output: z.object({ paused: z.array(SessionSchema), previous: z.array(SessionSchema), hasMore: z.boolean() }),
    tags,
  },
  /** One session's questions and the learner's answers. */
  sessionDetail: { input: SessionRef, output: z.object({ session: SessionSchema, exercises: z.array(ExerciseSchema) }), tags },
  /** Topics the tab offers for a manual start, from the thread's own data. */
  topicChoices: { input: ThreadRef, output: z.object({ choices: z.array(TopicChoiceSchema) }), tags },
  offerSeen: { input: z.object({ offerId: z.string().min(1) }), output: Done },
  /** Start (or Run here) starts a session and answers its thread; the others answer null. */
  answerOffer: {
    input: z.object({ offerId: z.string().min(1), answer: OfferAnswerSchema }),
    output: z.object({ threadId: z.string().nullable() }),
  },
  startSession: {
    input: ThreadRef.extend({
      topic: z.string().trim().min(1).max(300),
      trigger: TriggerKindSchema,
      refs: RefsSchema,
      here: z.boolean().optional(),
    }),
    output: z.object({ threadId: z.string() }),
  },
  pauseSession: { input: SessionRef, output: Done },
  resumeSession: { input: SessionRef, output: z.object({ threadId: z.string() }) },
  finishSession: { input: SessionRef, output: Done },
  deleteSession: { input: SessionRef, output: Done },
  /** Whether offers are on, per thread, for the thread menu. */
  threadOffers: {
    input: z.object({ threadIds: z.array(z.string().min(1)).max(THREAD_OFFERS_BATCH_MAX) }),
    output: z.object({ off: z.array(z.string()) }),
    tags,
  },
  setThreadOffers: { input: ThreadRef.extend({ on: z.boolean() }), output: Done },
  /** "Never for this project", and its Undo. */
  setProjectNever: { input: ThreadRef.extend({ never: z.boolean() }), output: Done },
  neverProjects: { input: z.object({}), output: z.object({ projects: z.array(z.object({ key: z.string(), name: z.string() })) }), tags },
  removeNeverProject: { input: z.object({ key: z.string().min(1) }), output: Done },
} satisfies PluginRpcContract;

export type RpcContract = typeof rpcContract;
