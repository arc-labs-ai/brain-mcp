/**
 * Typed edges between memories, and reading the graph they form.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { customerId, fail, ok } from "../result.js";

export function registerGraphTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "link",
    {
      title: "Link memories",
      description:
        "Connect two memories with a typed edge (caused, followed_by, " +
        "derived_from, similar_to, contradicts, supports, references, part_of). " +
        "Use when the relationship is real but neither memory states it.",
      inputSchema: {
        customer_id: customerId,
        source: z.string().min(1).describe("Source memory id."),
        target: z.string().min(1).describe("Target memory id."),
        kind: z.string().min(1).describe("Edge kind, e.g. `caused`."),
      },
    },
    async ({ customer_id, source, target, kind }) => {
      try {
        return ok(await backend.link(customer_id, source, target, kind));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "unlink",
    {
      title: "Unlink memories",
      description: "Remove a typed edge between two memories. Idempotent.",
      inputSchema: {
        customer_id: customerId,
        source: z.string().min(1).describe("Source memory id."),
        target: z.string().min(1).describe("Target memory id."),
        kind: z.string().min(1).describe("Edge kind to remove."),
      },
    },
    async ({ customer_id, source, target, kind }) => {
      try {
        return ok(await backend.unlink(customer_id, source, target, kind));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "graph",
    {
      title: "Read the graph",
      description:
        "A page of the customer's knowledge graph — entities and the relations " +
        "between them. Use to see structure; use recall to answer a question.",
      inputSchema: {
        customer_id: customerId,
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ customer_id, limit, cursor }) => {
      try {
        return ok(await backend.graph(customer_id, { limit, cursor }));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
