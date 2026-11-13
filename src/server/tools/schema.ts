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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Get schema",
      description:
        "The entity and relation types declared for this workspace. Read this " +
        "before creating entities — `entity_type_id` comes from here.",
      inputSchema: {
        namespace: z
          .string()
          .min(1)
          .optional()
          .describe("Namespace to read. Defaults to the caller's own."),
        version: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Read a specific past version instead of the active one — pair " +
              "with `list_schema_versions` to see what a declaration looked " +
              "like before a change.",
          ),
      },
    },
    async ({ namespace, version }) => {
      try {
        return ok(await backend.getSchema({ namespace, version }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "validate_schema",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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
        scope: z
          .enum(["namespace", "space"])
          .optional()
          .describe(
            "Where the declaration lives: `namespace` (default) is the " +
              "tenant's base, which every space resolves; `space` is an " +
              "overlay only the caller's own space sees. Not inferred from " +
              "the current space on purpose — that would quietly make every " +
              "ordinary declaration invisible to the rest of the tenant.",
          ),
      },
    },
    async ({ schema_document, scope }) => {
      try {
        return ok(await backend.validateSchema(schema_document, scope));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "upload_schema",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
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
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Parse, validate and report what WOULD change without committing. " +
              "`validate_schema` is the same check on a document you have not " +
              "decided to publish yet.",
          ),
        allow_breaking: z
          .boolean()
          .optional()
          .describe(
            "Consent to a change that is not backward compatible. Without it " +
              "such a document is refused rather than applied.",
          ),
        scope: z
          .enum(["namespace", "space"])
          .optional()
          .describe(
            "Where the declaration lives: `namespace` (default) is the " +
              "tenant's base, which every space resolves; `space` is an " +
              "overlay only the caller's own space sees. Not inferred from " +
              "the current space on purpose — that would quietly make every " +
              "ordinary declaration invisible to the rest of the tenant.",
          ),
      },
    },
    async ({ schema_document, dry_run, allow_breaking, scope }) => {
      try {
        return ok(
          await backend.uploadSchema(schema_document, { dry_run, allow_breaking, scope }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_schema_versions",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
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
        scope: z
          .enum(["namespace", "space"])
          .optional()
          .describe(
            "Where the declaration lives: `namespace` (default) is the " +
              "tenant's base, which every space resolves; `space` is an " +
              "overlay only the caller's own space sees. Not inferred from " +
              "the current space on purpose — that would quietly make every " +
              "ordinary declaration invisible to the rest of the tenant.",
          ),
      },
    },
    async ({ kind, name, force, scope }) => {
      try {
        return ok(await backend.dropSchemaType(kind, name, { force, scope }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "replace_schema",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Replace schema",
      description:
        "Replace the whole schema document, instead of merging into it. " +
        "DIFFERENT FROM `upload_schema` IN ONE WAY THAT MATTERS: upload is " +
        "additive, so the worst it can do is declare something new, while " +
        "this removes any declaration the new document leaves out — and the " +
        "rows bound to a dropped declaration go with it. Reach for " +
        "`upload_schema` to add, `drop_schema_type` to remove exactly one " +
        "thing, and this only to reset a schema wholesale against a document " +
        "you already have. Run it with `force_drop_existing: false` first: " +
        "that refuses rather than drops, which tells you what the true " +
        "setting would destroy.",
      inputSchema: {
        schema_document: z
          .string()
          .min(1)
          .describe(
            "The complete replacement document in Brain's schema DSL — NOT " +
              "JSON, and NOT a patch. Anything the active schema declares " +
              "and this document omits is a removal.",
          ),
        force_drop_existing: z
          .boolean()
          .describe(
            "REQUIRED, with no default, because the destructive choice must " +
              "not be made by leaving a field out. `false` refuses the " +
              "replacement if it would drop anything — run that first to see " +
              "what is at stake. `true` consents to dropping those " +
              "declarations and the rows that depend on them.",
          ),
        scope: z
          .enum(["namespace", "space"])
          .optional()
          .describe(
            "Where the declaration lives: `namespace` (default) is the " +
              "tenant's base, which every space resolves; `space` is an " +
              "overlay only the caller's own space sees.",
          ),
      },
    },
    async ({ schema_document, force_drop_existing, scope }) => {
      try {
        return ok(
          await backend.replaceSchema(schema_document, { force_drop_existing, scope }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
