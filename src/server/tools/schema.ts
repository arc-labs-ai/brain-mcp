/**
 * The declared entity and relation types. Destructive replace is deliberately absent — see `../index.ts`.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { customerId, fail, ok } from "../result.js";

export function registerSchemaTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "get_schema",
    {
      title: "Get schema",
      description:
        "The entity and relation types declared for this customer. Read this " +
        "before creating entities — `entity_type_id` comes from here.",
      inputSchema: { customer_id: customerId },
    },
    async ({ customer_id }) => {
      try {
        return ok(await backend.getSchema(customer_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "validate_schema",
    {
      title: "Validate schema",
      description:
        "Check a schema document without storing it. Use before upload_schema " +
        "so a malformed document is caught before it changes anything.",
      inputSchema: {
        customer_id: customerId,
        schema_document: z
          .string()
          .min(1)
          .describe(
            "The schema document, written in Brain's schema DSL \u2014 NOT JSON. " +
              "A JSON document is rejected with `syntax error at 1:1: expected " +
              "schema`. Example:\n\n" +
              "namespace acme\n" +
              "define entity_type Person { attributes {} }\n" +
              "define entity_type Org { attributes {} }\n" +
              "define predicate works_at { kind: Fact subject: Entity<Person> object: Entity<Org> }\n\n" +
              "The `namespace` line must name this customer's own namespace. " +
              "Call get_schema first to see what is already declared.",
          ),
      },
    },
    async ({ customer_id, schema_document }) => {
      try {
        return ok(await backend.validateSchema(customer_id, schema_document));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "upload_schema",
    {
      title: "Upload schema",
      description:
        "Merge new declarations into the customer's schema. Additive: it cannot " +
        "drop a declaration, and changing an existing one is a conflict. " +
        "Replacing a schema destructively is not available here.",
      inputSchema: {
        customer_id: customerId,
        schema_document: z
          .string()
          .min(1)
          .describe(
            "The schema document, written in Brain's schema DSL \u2014 NOT JSON. " +
              "A JSON document is rejected with `syntax error at 1:1: expected " +
              "schema`. Example:\n\n" +
              "namespace acme\n" +
              "define entity_type Person { attributes {} }\n" +
              "define entity_type Org { attributes {} }\n" +
              "define predicate works_at { kind: Fact subject: Entity<Person> object: Entity<Org> }\n\n" +
              "The `namespace` line must name this customer's own namespace. " +
              "Call get_schema first to see what is already declared.",
          ),
      },
    },
    async ({ customer_id, schema_document }) => {
      try {
        return ok(await backend.uploadSchema(customer_id, schema_document));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
