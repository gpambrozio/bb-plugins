/**
 * The RPC contract between the app and the server. Every method but `hosts`
 * and `health` names the Mac it acts on; the server forwards it to that
 * host's entry (`host-contract.ts`). The app imports this file as a type only:
 * it imports `defineRpcContract` from the SDK root, which only the server
 * bundle has.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HealthSchema, HostChoiceSchema } from "./channels";
import { JobListSchema, JobSchema, JobSpecSchema, LogChunkSchema } from "./jobs";

const HostId = z.string().min(1);
const OnHost = z.object({ hostId: HostId });
const JobOnHost = z.object({ hostId: HostId, id: z.string().min(1) });
const Empty = z.object({});

export const rpcContract = defineRpcContract({
  /** The Macs the panel can show, and the one it opens on: the server's own. */
  hosts: {
    input: Empty,
    output: z.object({ primaryHostId: z.string().nullable(), hosts: z.array(HostChoiceSchema) }),
  },
  list: { input: OnHost, output: JobListSchema },
  create: { input: z.object({ hostId: HostId, spec: JobSpecSchema }), output: JobSchema },
  update: { input: z.object({ hostId: HostId, id: z.string().min(1), spec: JobSpecSchema }), output: JobSchema },
  delete: { input: JobOnHost, output: Empty },
  run: { input: JobOnHost, output: Empty },
  setEnabled: { input: z.object({ hostId: HostId, id: z.string().min(1), enabled: z.boolean() }), output: JobSchema },
  log: {
    input: z.object({ hostId: HostId, id: z.string().min(1), from: z.number().int().min(0).optional() }),
    output: LogChunkSchema,
  },
  /** Starts or renews following a job's log; renew before `expiresInMs` passes. */
  follow: { input: JobOnHost, output: z.object({ expiresInMs: z.number().int().positive() }) },
  unfollow: { input: JobOnHost, output: Empty },
  /** The last failing count the server took; `refresh` takes a new one first. */
  health: { input: z.object({ refresh: z.boolean().default(false) }), output: HealthSchema },
  acknowledge: { input: JobOnHost, output: Empty },
});

export type RpcContract = typeof rpcContract;
