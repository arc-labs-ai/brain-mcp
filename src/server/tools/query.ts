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

export function registerQueryTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "explain_query",
    {
      title: "Explain query",
      description:
        "Show the plan Brain would use for a query, and what it expects that " +
        "to cost — without running it. Use when a recall came back slow or " +
        "empty and you want to know why before trying again. The cost is an " +
        "estimate; trace_query measures.",
      inputSchema: {
        text: z.string().min(1).describe("The query text you would have recalled with."),
      },
    },
    async ({ text }) => {
      try {
        return ok(await backend.explainQuery(text));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "trace_query",
    {
      title: "Trace query",
      description:
        "Run a query and report what each stage actually cost. Note that this " +
        "RUNS the query — it is not the free counterpart to explain_query. " +
        "Reach for it when the plan looks reasonable but the latency does not.",
      inputSchema: {
        text: z.string().min(1).describe("The query text to run and measure."),
      },
    },
    async ({ text }) => {
      try {
        return ok(await backend.traceQuery(text));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
