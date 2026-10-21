/**
 * The MCP server definition: a deliberately tiny surface of four tools
 * (`remember`, `recall`, `forget`, `whoami`). Tool-definition bloat is the #1
 * reason agents uninstall an MCP server, so this stays minimal — richer
 * typed-graph queries live behind the SDK/REST, not here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BackendError, type BrainBackend } from "./backend.js";

const SERVER_NAME = "brain-mcp";
const SERVER_VERSION = "0.1.0";

/** Render a successful tool result as pretty JSON text content. */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Render a failed tool call so the agent sees an actionable message. */
function fail(err: unknown): CallToolResult {
  const message =
    err instanceof BackendError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

const customerId = z
  .string()
  .min(1)
  .describe(
    "Stable id of the end customer / user this memory belongs to. Every tool is " +
      "scoped to one customer so their memories never leak across customers.",
  );

/**
 * Build a fresh {@link McpServer} wired to `backend`. In stateless HTTP mode a
 * new server is built per request, so this is called on each POST.
 */
export function buildServer(backend: BrainBackend): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store a fact, event, or conversation turn for a customer. Brain extracts " +
        "typed facts and supersedes stale ones automatically. Returns the memory id.",
      inputSchema: {
        customer_id: customerId,
        content: z
          .string()
          .min(1)
          .describe("The text to remember (a fact, message, or event)."),
      },
    },
    async ({ customer_id, content }) => {
      try {
        return ok(await backend.remember(customer_id, content));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Retrieve the current, consistent truth for a customer against a query. " +
        "Returns an answer shape (single / many / none) with evidence and " +
        "confidence — stale and contradicted facts are already resolved server-side.",
      inputSchema: {
        customer_id: customerId,
        query: z.string().min(1).describe("What you want to know about this customer."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Optional cap on the number of memories returned."),
      },
    },
    async ({ customer_id, query, max_results }) => {
      try {
        return ok(await backend.recall(customer_id, query, max_results));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description:
        "Delete a specific memory for a customer. Soft by default (tombstone with " +
        "a grace window); set hard=true to zero it immediately. Cascades to " +
        "dependent facts.",
      inputSchema: {
        customer_id: customerId,
        memory_id: z
          .string()
          .min(1)
          .describe("The memory id to forget (as returned by remember/recall)."),
        hard: z
          .boolean()
          .optional()
          .describe("Immediate zeroing instead of a soft tombstone. Default false."),
      },
    },
    async ({ customer_id, memory_id, hard }) => {
      try {
        return ok(await backend.forget(customer_id, memory_id, hard ?? false));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Report the effective identity (namespace + customer scope) a request " +
        "runs as. Useful to confirm the server is scoped to the intended customer.",
      inputSchema: {
        customer_id: customerId,
      },
    },
    async ({ customer_id }) => {
      try {
        return ok(await backend.whoami(customer_id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
