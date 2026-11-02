/**
 * Storing, retrieving and removing memories — the core loop most agents need.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";

export function registerMemoryTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store a fact, event, or conversation turn. Brain extracts " +
        "typed facts and supersedes stale ones automatically. Returns the memory id.",
      inputSchema: {
        content: z
          .string()
          .min(1)
          // The MCP transport caps a request body at 1 MB. Over that, express
          // rejects the POST with an HTML error page and the MCP client
          // *throws* — the agent gets a transport crash, not a tool error it
          // can read and act on. Capping below that turns it into an ordinary
          // schema error naming the offending argument.
          .max(262_144, "content must be at most 262144 characters (~256 KB)")
          .describe(
            "The text to remember (a fact, message, or event). Up to ~256 KB; " +
              "split anything larger into separate memories.",
          ),
      },
    },
    async ({ content }) => {
      try {
        return ok(await backend.remember(content));
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
        "Retrieve the current, consistent truth against a query. " +
        "Returns an answer shape (single / many / none) with evidence and " +
        "confidence — stale and contradicted facts are already resolved server-side.",
      inputSchema: {
        query: z.string().min(1).describe("What you want to know."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Optional cap on the number of memories returned."),
      },
    },
    async ({ query, max_results }) => {
      try {
        return ok(await backend.recall(query, max_results));
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
        "Delete a specific memory. Soft by default (tombstone with " +
        "a grace window); set hard=true to zero it immediately. Cascades to " +
        "dependent facts.",
      inputSchema: {
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
    async ({ memory_id, hard }) => {
      try {
        return ok(await backend.forget(memory_id, hard ?? false));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_memories",
    {
      title: "List memories",
      description:
        "Page through what is stored, newest first. Use when you " +
        "need to see what exists rather than answer a question — recall is for " +
        "questions, this is for inventory.",
      inputSchema: {
        // Brain's MEMORY_LIST caps the page at 100 (`handlers/memory_list.rs`,
        // MAX_LIMIT). Advertising 200 meant 101..200 passed validation here
        // and were refused by the server with `limit must be in 1..=100` —
        // the schema promising a page size the backend will not serve.
        limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ limit, cursor }) => {
      try {
        return ok(await backend.listMemories({ limit, cursor }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "inspect_memory",
    {
      title: "Inspect memory",
      description:
        "Everything behind one memory: the typed facts extracted from it, its " +
        "provenance, how it scored, and `edges` — the links to and from other " +
        "memories, including any you asserted with `link`. This is the only " +
        "way to read those back; `graph` is a different layer (typed entities " +
        "and relations) and never shows them. Use when an answer looks wrong " +
        "and you need to see why that memory was or was not used.",
      inputSchema: {
        memory_id: z.string().min(1).describe("The memory id to inspect."),
      },
    },
    async ({ memory_id }) => {
      try {
        return ok(await backend.inspectMemory(memory_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "materialize_directives",
    {
      title: "Materialize directives",
      description:
        "Render this workspace's stored directives — the standing instructions " +
        "it has learned — into a block ready to drop into a system prompt. " +
        "Call it at the start of a session rather than recalling directives " +
        "one at a time; it returns the block plus the statement ids it was " +
        "built from, so you can follow any line back to its source.",
      inputSchema: {
        top_k: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many directives to consider."),
        min_confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Drop anything below this confidence."),
        categories: z
          .array(z.string())
          .optional()
          .describe("Only these directive categories."),
      },
    },
    async ({ top_k, min_confidence, categories }) => {
      try {
        return ok(
          await backend.materialiseDirectives({ top_k, min_confidence, categories }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
