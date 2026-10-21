/**
 * Reading the extracted facts: statements and the relations between entities.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { customerId, fail, ok } from "../result.js";

export function registerKnowledgeTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "list_statements",
    {
      title: "List statements",
      description:
        "Page through the subject–predicate–object facts extracted from this " +
        "customer's memories. Use to audit what Brain believes, not to answer " +
        "a question.",
      inputSchema: {
        customer_id: customerId,
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ customer_id, limit, cursor }) => {
      try {
        return ok(await backend.listStatements(customer_id, { limit, cursor }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "get_statement",
    {
      title: "Get statement",
      description: "One statement by id, with the memory it came from.",
      inputSchema: {
        customer_id: customerId,
        statement_id: z.string().min(1).describe("The statement id."),
      },
    },
    async ({ customer_id, statement_id }) => {
      try {
        return ok(await backend.getStatement(customer_id, statement_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "get_relation",
    {
      title: "Get relation",
      description: "One relation by id, with its endpoints and type.",
      inputSchema: {
        customer_id: customerId,
        relation_id: z.string().min(1).describe("The relation id."),
      },
    },
    async ({ customer_id, relation_id }) => {
      try {
        return ok(await backend.getRelation(customer_id, relation_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
