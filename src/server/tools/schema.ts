/**
 * The declared entity and relation types. Destructive replace is deliberately absent — see `../index.ts`.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";

export function registerSchemaTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "get_schema",
    {
      title: "Get schema",
      description:
        "The entity and relation types declared for this workspace. Read this " +
        "before creating entities — `entity_type_id` comes from here.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.getSchema());
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
              "The `namespace` line must name this workspace's own namespace. " +
              "Call get_schema first to see what is already declared.",
          ),
      },
    },
    async ({ schema_document }) => {
      try {
        return ok(await backend.validateSchema(schema_document));
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
        "Merge new declarations into the workspace schema. Additive: it cannot " +
        "drop a declaration, and changing an existing one is a conflict. " +
        "Replacing a schema destructively is not available here.",
      inputSchema: {
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
              "The `namespace` line must name this workspace's own namespace. " +
              "Call get_schema first to see what is already declared.",
          ),
      },
    },
    async ({ schema_document }) => {
      try {
        return ok(await backend.uploadSchema(schema_document));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_schema_versions",
    {
      title: "List schema versions",
      description:
        "Page through the schema's version history. Distinct from get_schema, " +
        "which returns the one current document — use this to see when a " +
        "declaration appeared, or which version a statement was written " +
        "against.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ limit, cursor }) => {
      try {
        return ok(await backend.listSchemaVersions({ limit, cursor }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_extractors",
    {
      title: "List extractors",
      description:
        "The extractors registered for this workspace — what will read a new " +
        "memory and what it is allowed to produce. Read-only: extraction is " +
        "always on and cannot be turned off from here.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.listExtractors());
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "drop_schema_type",
    {
      title: "Drop schema type",
      description:
        "Remove one declared predicate or relation type. Only those two kinds " +
        "are droppable — entity types are shared across workspaces, so there " +
        "is no safe way to drop one from here. `force` is NOT a confirmation " +
        "flag: a type nothing uses drops without it, and force specifically " +
        "consents to orphaning live rows, which survive as plain memories that " +
        "are no longer enriched from the typed graph.",
      inputSchema: {
        kind: z
          .enum(["predicate", "relation_type"])
          .describe("Which declaration to drop."),
        name: z
          .string()
          .min(1)
          .describe("The declared name, in `namespace:name` form — e.g. `acme:prefers`."),
        force: z
          .boolean()
          .optional()
          .describe("Consent to orphan live rows that still use this type."),
      },
    },
    async ({ kind, name, force }) => {
      try {
        return ok(await backend.dropSchemaType(kind, name, force));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
