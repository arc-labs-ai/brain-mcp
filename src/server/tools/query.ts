/**
 * Query introspection: what Brain WOULD do, and what it actually did.
 *
 * Two tools rather than one with a flag, because the difference is whether
 * work is done. `explain_query` plans and returns an estimate; `trace_query`
 * runs the query and reports measured latency stage by stage. A single tool
 * with a `run: bool` would make that the easiest detail to miss.
 *
 * Registered onto a server built in `../index.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";
import { includeTombstoned, unixNanos } from "../schema.js";

/**
 * The query shape both tools take.
 *
 * Shared because the whole point of the pair is that they answer the same
 * question about the SAME query — a filter available to one and not the other
 * would make the plan you explained a different plan from the one you traced.
 */
const queryFields = {
  entity_anchor: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Entity id to anchor the query on, so retrieval starts from the graph " +
        "around one thing rather than from the cue alone.",
    ),
  kinds: z
    .array(z.enum(["fact", "preference", "event", "attribute", "relation", "directive"]))
    .optional()
    .describe("Only consider statements of these kinds."),
  predicates: z
    .array(z.string().min(1))
    .optional()
    .describe("Only consider statements using these predicates."),
  sessions: z
    .array(z.number().int().nonnegative())
    .optional()
    .describe("Restrict to these sessions."),
  time_range: z
    .object({
      from_unix_ms: z.number().int().nonnegative().optional(),
      to_unix_ms: z.number().int().nonnegative().optional(),
    })
    .optional()
    .describe("Event-time window, in unix MILLISECONDS (not nanoseconds)."),
  as_of_record_time_unix_nanos: unixNanos
    .optional()
    .describe(
      "Answer as the workspace stood at this instant — a time-travel read " +
        "that ignores anything recorded later. ISO-8601 is accepted.",
    ),
  confidence_min: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop candidates below this confidence."),
  include_tombstoned: includeTombstoned.optional(),
  include_superseded: z
    .boolean()
    .optional()
    .describe("Include claims a later one replaced. Default false."),
  limit: z.number().int().min(1).optional().describe("Cap on candidates considered."),
  retrievers: z
    .array(z.enum(["auto", "semantic", "lexical", "graph"]))
    .optional()
    .describe(
      'Pin which retriever lanes run. Omitted — or `["auto"]` — lets Brain ' +
        'route. Pinning is what makes an explain answer "what would THIS ' +
        'plan cost" rather than "what would the router pick today"; a ' +
        "missing lane changes the answer, so pin only to measure one lane.",
    ),
  fusion: z
    .object({
      k: z.number().int().min(1).optional(),
      semantic_weight: z.number().optional(),
      lexical_weight: z.number().optional(),
      graph_weight: z.number().optional(),
    })
    .optional()
    .describe(
      "Override the reciprocal-rank-fusion constant and per-lane weights " +
        "used to merge the lanes.",
    ),
};

export function registerQueryTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "explain_query",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Explain query",
      description:
        "Show the plan Brain WOULD use for a query and what it expects that " +
        "to cost. Does not execute. Use when a query returned something " +
        "surprising and you want to know which stage decided it. To measure a " +
        "slow query instead, use `trace_query`.",
      inputSchema: {
        text: z.string().min(1).describe("The query text you would have recalled with."),
        ...queryFields,
      },
    },
    async ({ text, ...opts }) => {
      try {
        return ok(await backend.explainQuery(text, opts));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "trace_query",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Trace query",
      description:
        "Run a query and report what each stage ACTUALLY cost. This EXECUTES " +
        "the query — it is not a dry run and not free. Use when something is " +
        "slow and you need the stage responsible; use `explain_query` when " +
        "the plan alone will do.",
      inputSchema: {
        text: z.string().min(1).describe("The query text to run and measure."),
        ...queryFields,
      },
    },
    async ({ text, ...opts }) => {
      try {
        return ok(await backend.traceQuery(text, opts));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
