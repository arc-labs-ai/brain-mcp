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
import { cursor, includeTombstoned, unixNanos } from "../schema.js";

export function registerMemoryTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "remember",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Remember",
      /*
       * THE STANDING INSTRUCTION LIVES HERE, not only in the skill.
       *
       * A skill's body is read only after the agent decides to load it, and
       * for an ordinary coding turn it usually does not — the one-line
       * description is all it ever sees. Measured: the same task, run twice
       * against the same skill, captured the decision once and stored nothing
       * the other time, and the agent's own account of why was "I'd have
       * loaded it if you'd used a trigger word".
       *
       * A tool description is in context on EVERY turn for every client that
       * has this server connected. So the behaviour that has to be reliable
       * belongs in this string, and the skill keeps the judgement that only
       * matters once somebody is already storing things.
       */
      description:
        "Store something a FUTURE session would be worse without. CALL THIS " +
        "WITHOUT BEING ASKED whenever one goes past in ordinary work: a " +
        "decision and WHY, a constraint learned the hard way, a project " +
        "convention, a rejected alternative and what went wrong, " +
        'who owns a system. Almost nobody says "remember that" — they say ' +
        "it once, in passing, and expect you to still know it next week. " +
        "Store it the moment it goes past, in one self-contained sentence, " +
        "and do not announce every write. Brain extracts typed facts and " +
        "supersedes ones that changed — so correcting a fact is another " +
        "`remember`, never a `forget`. Returns the memory id (a long decimal " +
        'string, NOT a UUID). Example: "Priya owns the billing service; we ' +
        'chose Postgres over Dynamo for the join". NEVER store secrets, keys ' +
        "or tokens, file contents you just read, what the repo already " +
        "says, or a restatement of the previous message.",
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
        session: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Session to attribute this write to, so the memory can later be " +
              "listed or materialised per conversation.",
          ),
        occurred_at_unix_nanos: unixNanos
          .optional()
          .describe(
            "When the remembered thing HAPPENED, if that differs from now. " +
              "Storage time is recorded either way; this is the event time " +
              'recall orders on. ISO-8601 is accepted: "2026-03-01T00:00:00Z".',
          ),
      },
    },
    async ({ content, session, occurred_at_unix_nanos }) => {
      try {
        return ok(await backend.remember(content, { session, occurred_at_unix_nanos }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "recall",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Recall",
      description:
        "Ask a question, get the CURRENT answer — stale and contradicted " +
        "facts are already resolved server-side. Returns an answer shape: " +
        "`single` (one answer), `multiple` (several are true at once — say so " +
        "rather than picking), or `none` (Brain holds nothing; this is a real " +
        "answer, not an error). Ranks by SIMILARITY, not recency, so a stale " +
        "claim can outrank its correction — use `statement_history` when that " +
        "matters. Use this when you have a question; use `list_memories` only " +
        'to browse what exists. Example: recall("what database did we choose ' +
        'and why").',
      inputSchema: {
        query: z.string().min(1).describe("What you want to know."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Optional cap on the number of memories returned."),
        subject: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A subject's NAME — not an entity id. Brain resolves it " +
              'server-side across every type ("Priya Nair", "the billing ' +
              'service"). Left out, Brain mines subjects from the cue ' +
              "itself; naming one ADDS a grounded candidate rather than " +
              "filtering the results, so use it when the cue is vague about " +
              "who it is asking about.",
          ),
        scope: z
          .enum(["space", "namespace"])
          .optional()
          .describe(
            "`space` (default) searches the caller's own space; `namespace` " +
              "fans out across every space in the namespace and merges.",
          ),
        include_graph: z
          .boolean()
          .optional()
          .describe(
            "Return what each hit is connected to — its entities, statements " +
              "and relations. Use this when the answer depends on how things " +
              "relate, not just on the text.",
          ),
        include_trace: z
          .boolean()
          .optional()
          .describe(
            "Return the read-pipeline trace: which retriever lanes ran, what " +
              "each contributed, and where the latency went. For diagnosing " +
              "ONE bad answer — the trace reports every candidate considered, " +
              "so it is large (~100 KB over a few hundred memories) and its " +
              "size does not follow `max_results`.",
          ),
      },
    },
    async ({ query, max_results, subject, scope, include_graph, include_trace }) => {
      try {
        return ok(
          await backend.recall(query, {
            max_results,
            subject,
            scope,
            include_graph,
            include_trace,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "forget",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Forget",
      description:
        "Delete ONE memory by id, for something that should never have been " +
        "stored — wrong, private, or noise. This is NOT how to update a fact: " +
        "a changed fact is another `remember`, which supersedes the old one " +
        'and keeps the chain so "what did we think before" stays answerable. ' +
        "Soft by default (tombstone); hard delete destroys the content. Takes " +
        "a memory id (long decimal), not a UUID.",
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "List memories",
      description:
        'Page through what is stored, newest first. For BROWSING — "what do ' +
        'you have about me", an audit, or showing a user their own data. When ' +
        "you have a question, use `recall` instead: it resolves " +
        "contradictions and ranks by relevance, and this does neither. " +
        'Example: answering "show me everything you remember".',
      inputSchema: {
        // Brain's MEMORY_LIST caps the page at 100 (`handlers/memory_list.rs`,
        // MAX_LIMIT). Advertising 200 meant 101..200 passed validation here
        // and were refused by the server with `limit must be in 1..=100` —
        // the schema promising a page size the backend will not serve.
        limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100."),
        cursor: cursor.optional(),
        dir: z
          .enum(["desc", "asc"])
          .optional()
          .describe("`desc` (default) is newest first; `asc` is oldest first."),
        include_tombstoned: includeTombstoned.optional(),
      },
    },
    async ({ limit, cursor, dir, include_tombstoned }) => {
      try {
        return ok(await backend.listMemories({ limit, cursor, dir, include_tombstoned }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "inspect_memory",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Inspect memory",
      description:
        "Everything behind ONE memory: the typed facts drawn from it, its " +
        "provenance, how it scored, and its edges to other memories. Use when " +
        "a recall returned something surprising and you want to know why THAT " +
        "memory matched. Takes a memory id (long decimal) — passing a " +
        "statement or entity UUID here resolves to nothing.",
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Materialize directives",
      description:
        "Render this workspace's stored directives — the standing instructions " +
        "it has learned — into a block ready to drop into a system prompt. " +
        "Call it at the start of a session rather than recalling directives " +
        "one at a time; it returns the block plus the statement ids it was " +
        "built from, so you can follow any line back to its source.",
      inputSchema: {
        sessions: z
          .array(z.number().int().nonnegative())
          .optional()
          .describe(
            "Only draw directives from these sessions. Omitted draws from " +
              "every session in the workspace.",
          ),
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
    async ({ sessions, top_k, min_confidence, categories }) => {
      try {
        return ok(
          await backend.materialiseDirectives({
            sessions,
            top_k,
            min_confidence,
            categories,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "encode_vector",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Store a pre-computed embedding",
      description:
        "Store a memory whose embedding the CALLER already computed. " +
        "ALMOST CERTAINLY NOT WHAT YOU WANT: `remember` takes text and lets " +
        "Brain embed it with the model the rest of the workspace was indexed " +
        "under. This exists for a program driving this server that holds " +
        "vectors from its own pipeline — a bulk import, or a migration off " +
        "another store. A vector from a different embedder than the one " +
        "named by `model_fingerprint` is refused; if it were accepted it " +
        "would be stored and then retrieved as noise, which is why the " +
        "fingerprint is required rather than inferred. `capabilities` " +
        "reports the dimension this deployment expects.",
      inputSchema: {
        text: z
          .string()
          .min(1)
          .describe("The text the vector was computed from. Stored as the content."),
        vector: z
          .array(z.number())
          .min(1)
          .describe(
            "The embedding, as plain floats. Its length must equal the " +
              "deployment's `vector_dim` from `capabilities` — 384 by default.",
          ),
        model_fingerprint: z
          .string()
          .regex(
            /^[0-9a-f]{32}$/,
            "model_fingerprint must be 32 lowercase hex characters (16 bytes)",
          )
          .describe(
            "A 16-byte id for the model that produced the vector, lowercase " +
              "hex. Brain rejects a vector whose fingerprint does not match " +
              "the index.",
          ),
        session: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Session to attribute the write to."),
        kind: z
          .number()
          .int()
          .min(0)
          .max(2)
          .optional()
          .describe("0 = episodic (default), 1 = semantic, 2 = consolidated."),
        salience_hint: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("A hint only — Brain decides the stored salience."),
        deduplicate: z
          .boolean()
          .optional()
          .describe("Skip the write when an identical memory already exists."),
      },
    },
    async ({
      text,
      vector,
      model_fingerprint,
      session,
      kind,
      salience_hint,
      deduplicate,
    }) => {
      try {
        return ok(
          await backend.encodeVector(text, vector, model_fingerprint, {
            session,
            kind,
            salience_hint,
            deduplicate,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
