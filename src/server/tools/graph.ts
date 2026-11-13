/**
 * Typed edges between memories, and reading the graph they form.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";
import { cursor, includeTombstoned } from "../schema.js";

export function registerGraphTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "link",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Link memories",
      description:
        "Connect two memories with a typed edge (caused, followed_by, " +
        "derived_from, similar_to, contradicts, supports, references, part_of). " +
        "Use when the relationship is real but neither memory states it. " +
        "Read the result back with inspect_memory, whose `edges` lists the " +
        "links in both directions.",
      inputSchema: {
        source: z.string().min(1).describe("Source memory id."),
        target: z.string().min(1).describe("Target memory id."),
        kind: z.string().min(1).describe("Edge kind, e.g. `caused`."),
        weight: z
          .number()
          .min(-1)
          .max(1)
          .optional()
          .describe(
            "Edge strength, default 1.0. `0..1` for every kind except " +
              "`contradicts`, which takes `-1..1` so the sign can carry which " +
              "way the contradiction runs.",
          ),
      },
    },
    async ({ source, target, kind, weight }) => {
      try {
        return ok(await backend.link(source, target, kind, weight));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "unlink",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Unlink memories",
      description: "Remove a typed edge between two memories. Idempotent.",
      inputSchema: {
        source: z.string().min(1).describe("Source memory id."),
        target: z.string().min(1).describe("Target memory id."),
        kind: z.string().min(1).describe("Edge kind to remove."),
      },
    },
    async ({ source, target, kind }) => {
      try {
        return ok(await backend.unlink(source, target, kind));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "graph",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Read the graph",
      description:
        "A page of the workspace's knowledge graph — entities and the relations " +
        "between them. Use to see structure; use recall to answer a question. " +
        "This is the typed-entity layer: edges asserted with `link` join two " +
        "memories and do NOT appear here — read those from inspect_memory.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Page size, 1-500 (default 200)."),
        cursor: cursor.optional(),
        include_statements: z
          .boolean()
          .optional()
          .describe(
            "Also emit statement nodes whose object is a literal value, with " +
              "their `has_statement` edges. Without this the page carries only " +
              "entity-to-entity structure.",
          ),
        include_memories: z
          .boolean()
          .optional()
          .describe(
            "Also emit the source memory nodes and the `mentions` edges tying " +
              "them to entities — where each fact came from.",
          ),
        include_memory_edges: z
          .boolean()
          .optional()
          .describe(
            "Also emit the memory-to-memory edges (`similar_to`, " +
              "`followed_by`, and anything asserted with `link`) between this " +
              "page's memory nodes. Requires `include_memories`; asking for it " +
              "alone is rejected.",
          ),
        include_tombstoned: includeTombstoned.optional(),
      },
    },
    async ({
      limit,
      cursor,
      include_statements,
      include_memories,
      include_memory_edges,
      include_tombstoned,
    }) => {
      try {
        return ok(
          await backend.graph({
            limit,
            cursor,
            include_statements,
            include_memories,
            include_memory_edges,
            include_tombstoned,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
