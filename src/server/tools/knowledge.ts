/**
 * The extracted facts: statements and the relations between entities — reading
 * them, and writing them back.
 *
 * Authoring is here because a graph an agent can only read is a graph it
 * cannot correct. `supersede_statement` is the one that carries the product
 * claim: it keeps the old version and the link to it, so "what did we believe
 * last week" survives the correction, where an overwrite would not.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";
import { cursor, includeTombstoned, unixNanos } from "../schema.js";

/**
 * A statement's object, in the tagged shape the contract uses on both sides.
 *
 * The id forms differ and the difference is not cosmetic: entity and statement
 * ids are UUIDs, a MEMORY id is a 128-bit decimal string. A memory id written
 * as a UUID looks right and cannot be fed back into `inspect_memory`, `link`
 * or a recall's memory refs.
 */
const statementObject = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entity"),
    id: z.string().min(1).describe("Entity id (UUID)."),
  }),
  z.object({
    kind: z.literal("memory"),
    id: z.string().min(1).describe("Memory id — a 128-bit DECIMAL string, not a UUID."),
  }),
  z.object({
    kind: z.literal("statement"),
    id: z.string().min(1).describe("Statement id (UUID)."),
  }),
  z.object({
    kind: z.literal("value"),
    value: z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), value: z.string() }),
      z.object({ type: z.literal("integer"), value: z.number().int() }),
      z.object({ type: z.literal("float"), value: z.number() }),
      z.object({ type: z.literal("bool"), value: z.boolean() }),
      z.object({ type: z.literal("unix_nanos"), value: z.number().int().nonnegative() }),
      z.object({
        type: z.literal("blob"),
        value: z.array(z.number().int().min(0).max(255)),
      }),
    ]),
  }),
]);

/** The fields a claim is made of. Shared by create and supersede, because the
 *  supersede body is a whole replacement statement rather than a patch. */
const statementFields = {
  kind: z
    .enum(["fact", "preference", "event", "attribute", "relation", "directive"])
    .describe("What sort of claim this is."),
  subject: z.string().min(1).describe("The subject entity id (UUID)."),
  predicate: z
    .string()
    .min(1)
    .describe(
      "The predicate, in `namespace:name` form — e.g. `acme:prefers`, not " +
        "`prefers`. A bare name is rejected. Use whoami to find your namespace " +
        "and get_schema for what is declared in it.",
    ),
  object: statementObject.describe("What the claim is about."),
  confidence: z.number().min(0).max(1).optional().describe("0..1. Defaults to certain."),
  event_at_unix_nanos: unixNanos
    .optional()
    .describe(
      "When the thing HAPPENED — distinct from when the claim is held true. " +
        "ISO-8601 (`2026-03-01T00:00:00Z`) or unix nanoseconds.",
    ),
  valid_from_unix_nanos: unixNanos
    .optional()
    .describe(
      "When the claim starts being true. ISO-8601 or unix nanoseconds. " +
        "Omitted = now.",
    ),
  valid_to_unix_nanos: unixNanos
    .optional()
    .describe("When it stops. ISO-8601 or unix nanoseconds. Omitted = still valid."),
  session_id: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Session to attribute it to."),
  evidence: z
    .array(z.string())
    .optional()
    .describe("Memory ids this claim rests on (128-bit decimal strings)."),
};

/** The fields a typed edge is made of. Shared by create and supersede. */
const relationFields = {
  relation_type: z
    .string()
    .min(1)
    .describe(
      "The relation type, in `namespace:name` form — e.g. `acme:works_at`, not " +
        "`works_at`. A bare name is rejected. Use whoami to find your namespace " +
        "and get_schema for what is declared in it.",
    ),
  from_entity: z.string().min(1).describe("Source entity id (UUID)."),
  to_entity: z.string().min(1).describe("Target entity id (UUID)."),
  confidence: z.number().min(0).max(1).optional().describe("0..1. Defaults to certain."),
  /*
   * THE SAME THREE CONCEPTS THE STATEMENT FIELDS ABOVE ALREADY EXPLAIN, and
   * for a while these three carried no description at all — the relation path
   * was added later and did not inherit that care. An undescribed field is
   * not a field an agent leaves alone; it is one it guesses at, and the
   * guesses here are all silent. A validity window in the wrong epoch stores
   * cleanly and makes the edge invisible to every time-bounded query.
   */
  valid_from_unix_nanos: unixNanos
    .optional()
    .describe(
      "When the edge starts being true IN THE WORLD — object time, not when " +
        "you are recording it. ISO-8601 (`2026-03-01T00:00:00Z`) or unix " +
        "nanoseconds. Omitted = now.",
    ),
  valid_to_unix_nanos: unixNanos
    .optional()
    .describe(
      "When it stops being true in the world. ISO-8601 or unix nanoseconds. " +
        "Omitted = still valid. Set this to end an edge that is simply over; " +
        "use supersede_relation when it was REPLACED by a different one.",
    ),
  session_id: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Attribute this edge to a session created with create_session. " +
        "Grouping only — a session is NOT an isolation boundary, and omitting " +
        "it files the edge under session 0, the default. Leave it unset unless " +
        "a caller asked for the write to be attributed.",
    ),
  evidence: z.array(z.string()).optional().describe("Memory ids this edge rests on."),
  properties: z
    .string()
    .optional()
    .describe(
      "Opaque bytes the server stores and never interprets, hex-encoded " +
        "lowercase — NOT a JSON object. There is nothing useful to put here " +
        "unless you were handed the bytes; omit it.",
    ),
};

/**
 * Retirement reasons, by name rather than by number.
 *
 * The wire takes a byte and accepts only `1..=4`; `0` is rejected outright, so
 * a tool that defaulted to "unset" would fail every call that did not name a
 * reason. Naming them also stops an agent inventing a code.
 */
const RETIRE_REASON = {
  source_memory_forgotten: 1,
  user_request: 2,
  schema_invalidation: 3,
  extractor_retraction: 4,
} as const;

const retireReason = z
  .enum([
    "source_memory_forgotten",
    "user_request",
    "schema_invalidation",
    "extractor_retraction",
  ])
  .optional()
  .describe("Why it is being retired. Defaults to user_request.");

function reasonByte(name: keyof typeof RETIRE_REASON | undefined): number {
  return RETIRE_REASON[name ?? "user_request"];
}

export function registerKnowledgeTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "list_statements",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "List statements",
      description:
        "Page through the subject–predicate–object facts extracted from this " +
        "workspace's memories. Use to audit what Brain believes, not to answer " +
        "a question.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Page size, 1-1000."),
        cursor: cursor.optional(),
        subject: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Subject entity id (UUID) — every claim about one thing. Resolve " +
              "the name with `resolve_entity` first.",
          ),
        predicate: z
          .string()
          .min(1)
          .optional()
          .describe("Only claims using this predicate, e.g. `brain:reports_to`."),
        kind: z
          .enum(["fact", "preference", "event", "attribute", "relation", "directive"])
          .optional()
          .describe("Only claims of this kind."),
        min_confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Drop claims the extractor was less sure of than this."),
        only_current: z
          .boolean()
          .optional()
          .describe(
            "Only claims nothing has superseded. Defaults to TRUE — pass " +
              "false to see the history alongside the current answer.",
          ),
        include_tombstoned: includeTombstoned.optional(),
      },
    },
    async ({
      limit,
      cursor,
      subject,
      predicate,
      kind,
      min_confidence,
      only_current,
      include_tombstoned,
    }) => {
      try {
        return ok(
          await backend.listStatements({
            limit,
            cursor,
            subject,
            predicate,
            kind,
            min_confidence,
            only_current,
            include_tombstoned,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "get_statement",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Get statement",
      description: "One statement by id, with the memory it came from.",
      inputSchema: {
        statement_id: z.string().min(1).describe("The statement id."),
        follow_supersession: z
          .boolean()
          .optional()
          .describe(
            "Follow the chain to whatever currently replaces this claim, " +
              "rather than returning the superseded version you asked for.",
          ),
      },
    },
    async ({ statement_id, follow_supersession }) => {
      try {
        return ok(await backend.getStatement(statement_id, follow_supersession));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "get_relation",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Get relation",
      description: "One relation by id, with its endpoints and type.",
      inputSchema: {
        relation_id: z.string().min(1).describe("The relation id."),
        follow_supersession: z
          .boolean()
          .optional()
          .describe(
            "Follow the chain to whatever currently replaces this relation, " +
              "rather than returning the superseded version you asked for.",
          ),
      },
    },
    async ({ relation_id, follow_supersession }) => {
      try {
        return ok(await backend.getRelation(relation_id, follow_supersession));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "statement_history",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Statement history",
      description:
        "The full supersession chain for a claim, oldest to newest. Reach for " +
        "this when a recall and a statement disagree, or before correcting " +
        "something: recall ranks by similarity, so a superseded claim can " +
        "outrank the one that replaced it, and the chain is what tells them " +
        "apart.",
      inputSchema: {
        statement_id: z.string().min(1).describe("Any statement in the chain."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Page size, 1-1000."),
        cursor: cursor.optional(),
        include_tombstoned: includeTombstoned.optional(),
      },
    },
    async ({ statement_id, limit, cursor, include_tombstoned }) => {
      try {
        return ok(
          await backend.statementHistory(statement_id, {
            limit,
            cursor,
            include_tombstoned,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- authoring ---------------------------------------------------------

  server.registerTool(
    "create_statement",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Create statement",
      description:
        "Assert a claim directly, rather than waiting for extraction to infer " +
        "one. Use when the user states a fact outright. Both temporal fields " +
        "are worth getting right: event_at is when the thing HAPPENED, " +
        "valid_from/valid_to are when the claim is held to be true — a meeting " +
        "held Monday and learned about Tuesday has different values for each.",
      inputSchema: statementFields,
    },
    async (args) => {
      try {
        return ok(await backend.createStatement(args));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "supersede_statement",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Supersede statement",
      description:
        "Replace a claim with a corrected one. BOTH survive, linked, and the " +
        "new one becomes current — this is almost always the right way to " +
        'correct something, because it keeps "what changed and when" ' +
        'answerable. Example: "Priya owns billing" superseded by "Raj owns ' +
        'billing". Send every field of the replacement; this is not a patch.',
      inputSchema: {
        statement_id: z.string().min(1).describe("The claim being replaced."),
        ...statementFields,
      },
    },
    async ({ statement_id, ...body }) => {
      try {
        return ok(await backend.supersedeStatement(statement_id, body));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "delete_statement",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Delete statement",
      description:
        "Soft-tombstone a claim: the row survives for audit and stops being " +
        "returned. Use when the claim should not have been recorded at all. " +
        "To CORRECT a claim use `supersede_statement`, which keeps the chain; " +
        "to destroy the content itself use `retract_statement`.",
      inputSchema: {
        statement_id: z.string().min(1).describe("The claim to tombstone."),
        reason: retireReason,
        message: z.string().optional().describe("A human note kept alongside it."),
      },
    },
    async ({ statement_id, reason, message }) => {
      try {
        return ok(
          await backend.deleteStatement(statement_id, {
            reason: reasonByte(reason),
            message,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "retract_statement",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Retract statement",
      description:
        "Retract a claim so its CONTENT does not survive — the strongest " +
        "removal here. For something that should never have existed: a secret " +
        "pasted by accident, a false and harmful claim about a person. Prefer " +
        "`delete_statement` (keeps an audit row) or `supersede_statement` " +
        "(keeps the chain); reach for this only when the content itself is " +
        'the problem, because it destroys the history that makes "what ' +
        'changed" answerable.',
      inputSchema: {
        statement_id: z.string().min(1).describe("The claim to retract."),
        reason: retireReason,
        message: z.string().optional().describe("A human note kept alongside it."),
      },
    },
    async ({ statement_id, reason, message }) => {
      try {
        return ok(
          await backend.retractStatement(statement_id, {
            reason: reasonByte(reason),
            message,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "create_relation",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Create relation",
      description:
        "Assert a typed edge between two entities. The relation type is " +
        "`namespace:name` — a bare name is rejected — and must already be " +
        "declared in the schema; check get_schema if a call is refused. For " +
        "an untyped association between two MEMORIES, use `link` instead.",
      inputSchema: relationFields,
    },
    async (args) => {
      try {
        return ok(await backend.createRelation(args));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "supersede_relation",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Supersede relation",
      description:
        "Replace an edge with a corrected one, keeping the chain. Send every " +
        "field: the replacement is whole, and its properties blob REPLACES the " +
        "old one rather than merging into it.",
      inputSchema: {
        relation_id: z.string().min(1).describe("The edge being replaced."),
        ...relationFields,
      },
    },
    async ({ relation_id, ...body }) => {
      try {
        return ok(await backend.supersedeRelation(relation_id, body));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "delete_relation",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Delete relation",
      description:
        "Tombstone a typed edge BETWEEN ENTITIES. Traversals stop crossing " +
        "it. If the edge is merely out of date, supersede_relation keeps the " +
        "history; to remove an untyped edge between two MEMORIES, use " +
        "`unlink`.",
      inputSchema: {
        relation_id: z.string().min(1).describe("The edge to tombstone."),
        reason: retireReason,
        message: z.string().optional().describe("A human note kept alongside it."),
      },
    },
    async ({ relation_id, reason, message }) => {
      try {
        return ok(
          await backend.deleteRelation(relation_id, {
            reason: reasonByte(reason),
            message,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
