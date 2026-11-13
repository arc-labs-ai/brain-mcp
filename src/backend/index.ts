/**
 * Thin HTTP client for the Brain REST surface (`/v1/*`).
 *
 * One instance per CALLER, not per process: the instance closes over the
 * credential the caller presented, and every request goes out as that
 * credential. The backend resolves identity from it — for an API key, the
 * (namespace, space) the key is bound to — so isolation between callers is the
 * backend's existing per-key scoping rather than anything this server decides.
 *
 * That is why there are no scope headers here. The gateway reads
 * `x-brain-namespace` / `x-brain-space` only for console JWTs and ignores them
 * for API keys (`services/gateway/src/api/middleware/auth.rs`), so sending
 * them alongside a key was a no-op that read like isolation.
 */

import type { Config } from "../config/index.js";

/** A backend call that returned a non-2xx status. Carries the status + body so
 *  the tool layer can surface an actionable message to the agent. */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`brain backend returned ${status}: ${body.slice(0, 500)}`);
    this.name = "BackendError";
  }
}

export interface RecalledMemory {
  memory_id: string;
  text: string;
  similarity_score: number;
  confidence: number;
  salience: number;
  kind: number;
  created_at_unix_nanos: number;
}

export interface RecallResult {
  /** `single` | `many` | `none` — the router's answer shape. */
  answer_kind: string;
  memories: RecalledMemory[];
}

export interface RememberResult {
  memory_id: string;
  [k: string]: unknown;
}

export interface ForgetResult {
  [k: string]: unknown;
}

/**
 * A statement object, in the tagged shape the contract uses on both sides —
 * `POST /v1/statements` takes exactly what `GET` returns, so there is one
 * representation rather than two that can drift.
 *
 * Note which ids are which: entity and statement ids are UUID strings, a
 * MEMORY id is a 128-bit decimal string. Rendering a memory id as a UUID
 * produced something that looked right and could not be fed back into
 * `inspect_memory`, `link` or a recall's memory refs.
 */
export type StatementObject =
  | { kind: "entity"; id: string }
  | { kind: "memory"; id: string }
  | { kind: "statement"; id: string }
  | { kind: "value"; value: StatementValue };

/** A literal scalar object value. */
export type StatementValue =
  | { type: "text"; value: string }
  | { type: "integer"; value: number }
  | { type: "float"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "unix_nanos"; value: number }
  | { type: "blob"; value: number[] };

/**
 * The body `POST /v1/statements` and `.../supersede` both take — the supersede
 * body is a flattened create, not a wrapper, so one type serves both.
 */
export interface StatementBody {
  /** `fact` | `preference` | `event` | `attribute` | `relation` | `directive`. */
  kind: string;
  /** The subject entity (UUID). */
  subject: string;
  predicate: string;
  object: StatementObject;
  /** `[0,1]`; the server defaults to certain. */
  confidence?: number;
  /** When the content HAPPENED. */
  event_at_unix_nanos?: number;
  /** When the claim starts being held true. `0`/omitted = now. */
  valid_from_unix_nanos?: number;
  /** When it stops. `0`/omitted = still valid. */
  valid_to_unix_nanos?: number;
  extractor_id?: number;
  schema_version?: number;
  session_id?: number;
  /** Memory ids this claim rests on (128-bit decimal strings). */
  evidence?: string[];
}

/** The body `POST /v1/relations` and `.../supersede` both take. */
export interface RelationBody {
  /** The relation type, as declared in the schema. */
  relation_type: string;
  /** Source entity (UUID). */
  from_entity: string;
  /** Target entity (UUID). */
  to_entity: string;
  confidence?: number;
  valid_from_unix_nanos?: number;
  valid_to_unix_nanos?: number;
  extractor_id?: number;
  session_id?: number;
  evidence?: string[];
  /** Opaque property blob, lowercase hex. A supersede REPLACES it. */
  properties?: string;
}

/**
 * Append defined params as a query string. Undefined entries are dropped, so a
 * caller can pass optionals through without building the string itself — and
 * values are encoded, so an id or cursor containing `&` or `=` cannot alter
 * the query it is placed in.
 */
function withQuery(path: string, params: object): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Drop undefined entries from a request body.
 *
 * An omitted option must be ABSENT, not `null`. Every optional field on the
 * edge is `#[serde(default)]` over an `Option`, so an absent key takes the
 * documented default while an explicit `null` is a type error on the fields
 * that are not themselves nullable.
 */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

/**
 * Replace the raw embedding in an inspect response with a description of it.
 *
 * Measured against a live server, `artifact.vector` was 4,716 of 8,701
 * characters — 54% of the response — and it is 384 floats an agent can do
 * nothing with. Every `inspect_memory` call spent most of its context budget
 * on noise. The shape and magnitude are kept, because "is there an embedding
 * and is it sane" is the only question the raw numbers could answer.
 */
function summariseArtifact(raw: Record<string, unknown>): Record<string, unknown> {
  const artifact = raw.artifact;
  if (typeof artifact !== "object" || artifact === null) return raw;
  const a = artifact as Record<string, unknown>;
  if (!Array.isArray(a.vector)) return raw;

  const vector = a.vector as unknown[];
  let sumSquares = 0;
  for (const v of vector) if (typeof v === "number") sumSquares += v * v;

  return {
    ...raw,
    artifact: {
      ...a,
      vector: {
        note: "embedding omitted — 384 floats are not actionable for an agent",
        dimensions: vector.length,
        magnitude: Number(Math.sqrt(sumSquares).toFixed(4)),
      },
    },
  };
}

// ---------------------------------------------------------------------
// Option bags
// ---------------------------------------------------------------------
//
// One per route that takes more than its required arguments, named for the
// route rather than the tool so the mapping to the edge's DTO stays visible.
// Field names are the WIRE names, so a handler forwards its arguments without
// a translation step that could silently drop one.

/** `POST /v1/memories` beyond the text. */
export interface RememberOptions {
  /** Session to attribute the write to. */
  session?: number;
  /** When the remembered thing happened, as opposed to when it was stored. */
  occurred_at_unix_nanos?: number;
}

/** `POST /v1/recall` beyond the cue. */
export interface RecallOptions {
  max_results?: number;
  /** Narrow the cue to claims about one subject. */
  subject?: string;
  /** `space` (default, the caller's own) or `namespace` (every space in it). */
  scope?: string;
  /** Return the read-pipeline trace. Large — it grows with the space, not with
   *  `max_results`. */
  include_trace?: boolean;
  /** Return each hit's typed-graph enrichment. */
  include_graph?: boolean;
}

/** `GET /v1/memories`. */
export interface ListMemoriesOptions {
  limit?: number;
  cursor?: string;
  /** `desc` (default, newest first) or `asc`. */
  dir?: string;
  include_tombstoned?: boolean;
}

/** `GET /v1/graph`. */
export interface GraphOptions {
  limit?: number;
  cursor?: string;
  include_statements?: boolean;
  include_memories?: boolean;
  /** Requires `include_memories`; rejected on its own. */
  include_memory_edges?: boolean;
  include_tombstoned?: boolean;
}

/** `GET /v1/entities`, beyond the required type. */
export interface ListEntitiesOptions {
  limit?: number;
  cursor?: string;
  /** Name-prefix filter. */
  prefix?: string;
  mention_count_min?: number;
  include_tombstoned?: boolean;
  /** Include entities merged away into a survivor. */
  include_merged?: boolean;
}

/** `POST /v1/entities/resolve`, beyond the candidate name. */
export interface ResolveEntityOptions {
  /** Free text that disambiguates which of several same-named things is meant. */
  resolution_context?: string;
  /** Entity type to resolve within; omitted resolves across every type. */
  type_hint?: number;
  /** Mint a new entity on a miss. Default false — resolve is a read. */
  allow_create?: boolean;
}

/** `POST /v1/entities/{id}/traverse`. */
export interface TraverseOptions {
  /** `outgoing` (default), `incoming`, or `both`. */
  direction?: string;
  /** Relation types to follow; empty follows every type. */
  relation_types?: string[];
  max_depth?: number;
  max_nodes?: number;
  include_superseded?: boolean;
}

/** `GET /v1/entities/{id}/relations`. */
export interface EntityRelationsOptions {
  limit?: number;
  cursor?: string;
  /** `from`/outgoing (default) or `to`/incoming. */
  direction?: string;
  /** Relation-type filter. Sent as `type`, which is the query field's name. */
  relation_type?: string;
  include_superseded?: boolean;
  include_tombstoned?: boolean;
}

/** `GET /v1/statements`. */
export interface ListStatementsOptions {
  limit?: number;
  cursor?: string;
  /** Subject entity id (UUID). */
  subject?: string;
  predicate?: string;
  /** `fact`, `preference`, … */
  kind?: string;
  min_confidence?: number;
  /** Only non-superseded statements. Defaults to TRUE server-side. */
  only_current?: boolean;
  include_tombstoned?: boolean;
}

/** `GET /v1/statements/{id}/history`. */
export interface StatementHistoryOptions {
  limit?: number;
  cursor?: string;
  include_tombstoned?: boolean;
}

/** `POST /v1/reason`, beyond the observation. */
export interface ReasonOptions {
  /** Inference hops to take. */
  depth?: number;
  /** Floor an inference must clear to be reported. */
  confidence_threshold?: number;
  max_inferences?: number;
  budget_wall_time_ms?: number;
  include_trace?: boolean;
}

/** `POST /v1/plan`, beyond the endpoints. */
export interface PlanOptions {
  max_steps?: number;
  max_wall_time_ms?: number;
  max_branches?: number;
  strategy?: string;
  include_trace?: boolean;
}

/** `POST /v1/query/explain` and `/trace`, beyond the cue text. */
export interface QueryOptions {
  /** Entity id to anchor the query on. */
  entity_anchor?: string;
  kinds?: string[];
  predicates?: string[];
  sessions?: number[];
  time_range?: { from_unix_ms?: number; to_unix_ms?: number };
  as_of_record_time_unix_nanos?: number;
  confidence_min?: number;
  include_tombstoned?: boolean;
  include_superseded?: boolean;
  limit?: number;
  /** Retriever lanes to run; omitted runs the planner's choice. */
  retrievers?: string[];
  fusion?: {
    k?: number;
    semantic_weight?: number;
    lexical_weight?: number;
    graph_weight?: number;
  };
}

/** `POST /v1/schema` and `/validate`. */
export interface SchemaOptions {
  /** Validate and report without committing. */
  dry_run?: boolean;
  /** Permit a change that invalidates existing data. */
  allow_breaking?: boolean;
}

export class BrainBackend {
  /**
   * @param cfg   Process-wide settings: where the backend is, how long to wait.
   * @param credential The CALLER's bearer credential, forwarded verbatim as
   *   `Authorization`. Never read from the environment on the HTTP path — a
   *   server-held fallback is ambient authority, and one misconfigured
   *   deployment would put every anonymous caller in that key's workspace.
   */
  constructor(
    private readonly cfg: Config,
    private readonly credential: string,
  ) {}

  /** Ingest text as a memory in the caller's workspace. */
  async remember(content: string, opts: RememberOptions = {}): Promise<RememberResult> {
    return this.request<RememberResult>(
      "POST",
      "/v1/memories",
      compact({
        text: content,
        session: opts.session,
        occurred_at_unix_nanos: opts.occurred_at_unix_nanos,
      }),
    );
  }

  /** Recall the current, consistent truth for the caller against `query`. */
  async recall(query: string, opts: RecallOptions = {}): Promise<RecallResult> {
    return this.request<RecallResult>(
      "POST",
      "/v1/recall",
      compact({
        query,
        max_results: opts.max_results,
        subject: opts.subject,
        scope: opts.scope,
        include_trace: opts.include_trace,
        include_graph: opts.include_graph,
      }),
    );
  }

  /** Tombstone (soft) or zero (hard) a memory. */
  async forget(memoryId: string, hard: boolean): Promise<ForgetResult> {
    return this.request<ForgetResult>("DELETE", "/v1/memories", {
      memory_id: memoryId,
      hard,
    });
  }

  /**
   * The identity the backend resolves from the caller's credential.
   *
   * No fallback. `/v1/whoami` is a real route (brain-edge mounts it and the
   * gateway mounts that router), and this is the one tool a caller uses to
   * answer "am I connected as me?" — synthesising an answer from local config
   * would make the single most load-bearing check the one most able to lie.
   */
  async whoami(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/whoami", undefined);
  }

  // ---------------------------------------------------------------------
  // Memory reads
  // ---------------------------------------------------------------------

  /** List stored memories, newest first. */
  async listMemories(opts: ListMemoriesOptions = {}): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/memories", opts), undefined);
  }

  /** Full detail for one memory: the extracted graph, provenance, scoring. */
  /**
   * Store a memory whose embedding the CALLER computed.
   *
   * The vector must match the engine's dimension and the model that produced
   * it — `model_fingerprint` is how Brain refuses a vector from a different
   * embedder, which would otherwise be stored and retrieved as noise.
   * `capabilities` reports the dimension this deployment expects.
   */
  async encodeVector(
    text: string,
    vector: number[],
    modelFingerprint: string,
    opts: {
      session?: number;
      kind?: number;
      salience_hint?: number;
      deduplicate?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/memories/vector",
      compact({
        text,
        vector,
        model_fingerprint: modelFingerprint,
        session: opts.session,
        kind: opts.kind,
        salience_hint: opts.salience_hint,
        deduplicate: opts.deduplicate,
      }),
    );
  }

  async inspectMemory(memoryId: string): Promise<Record<string, unknown>> {
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      `/v1/memories/${encodeURIComponent(memoryId)}/inspect`,
      undefined,
    );
    return summariseArtifact(raw);
  }

  // ---------------------------------------------------------------------
  // Cognitive operations
  // ---------------------------------------------------------------------

  /** Plan a route from a start state to a goal over the stored graph. */
  async plan(
    start: string,
    goal: string,
    opts: PlanOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/plan",
      compact({
        start: { text: start },
        goal: { text: goal },
        max_steps: opts.max_steps,
        max_wall_time_ms: opts.max_wall_time_ms,
        max_branches: opts.max_branches,
        strategy: opts.strategy,
        include_trace: opts.include_trace,
      }),
    );
  }

  /** Infer over the stored graph from an observation. */
  async reason(
    observation: string,
    opts: ReasonOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/reason",
      compact({
        observation: { text: observation },
        depth: opts.depth,
        confidence_threshold: opts.confidence_threshold,
        max_inferences: opts.max_inferences,
        budget_wall_time_ms: opts.budget_wall_time_ms,
        include_trace: opts.include_trace,
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Graph edges
  // ---------------------------------------------------------------------

  /** Link two memories with a typed edge. */
  async link(
    source: string,
    target: string,
    kind: string,
    weight?: number,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/links", compact({ source, target, kind, weight }));
  }

  /** Remove a typed edge between two memories. */
  async unlink(
    source: string,
    target: string,
    kind: string,
  ): Promise<Record<string, unknown>> {
    return this.request("DELETE", "/v1/links", { source, target, kind });
  }

  /** A page of the knowledge graph. */
  async graph(opts: GraphOptions = {}): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/graph", opts), undefined);
  }

  // ---------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------

  /** Create an entity of a declared type. */
  async createEntity(
    entityTypeId: number,
    canonicalName: string,
    aliases?: string[],
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/entities",
      compact({
        entity_type_id: entityTypeId,
        canonical_name: canonicalName,
        aliases,
      }),
    );
  }

  /** List entities. `entity_type_id` is required by the edge — a list across
   *  every type is refused rather than silently paged. */
  async listEntities(
    entityTypeId: number,
    opts: ListEntitiesOptions = {},
  ): Promise<Record<string, unknown>> {
    // The edge reads the type as `type_id`; `entity_type_id` is the wire
    // field's name and reaches it only after that rename.
    return this.request(
      "GET",
      withQuery("/v1/entities", { type_id: entityTypeId, ...opts }),
      undefined,
    );
  }

  /** Resolve a surface form to an existing entity (or report no match). */
  async resolveEntity(
    candidateName: string,
    opts: ResolveEntityOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/entities/resolve",
      compact({
        candidate_name: candidateName,
        resolution_context: opts.resolution_context,
        type_hint: opts.type_hint,
        allow_create: opts.allow_create,
      }),
    );
  }

  /** One entity by id. */
  async getEntity(entityId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/entities/${encodeURIComponent(entityId)}`, undefined);
  }

  /** Walk the relation graph outward from an entity. */
  async traverseEntity(
    entityId: string,
    opts: TraverseOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/entities/${encodeURIComponent(entityId)}/traverse`,
      compact({ ...opts }),
    );
  }

  /** Relations attached to an entity. */
  async entityRelations(
    entityId: string,
    opts: EntityRelationsOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      withQuery(`/v1/entities/${encodeURIComponent(entityId)}/relations`, {
        ...opts,
        relation_type: undefined,
        // The query field is `type`; `relation_type` is the option's name and
        // reaches the edge only after this rename.
        type: opts.relation_type,
      }),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Statements and relations
  // ---------------------------------------------------------------------

  /** List statements (subject–predicate–object facts). */
  async listStatements(
    opts: ListStatementsOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/statements", opts), undefined);
  }

  /** One statement by id. */
  async getStatement(
    statementId: string,
    followSupersession?: boolean,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      withQuery(`/v1/statements/${encodeURIComponent(statementId)}`, {
        follow_supersession: followSupersession,
      }),
      undefined,
    );
  }

  /** One relation by id. */
  async getRelation(
    relationId: string,
    followSupersession?: boolean,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      withQuery(`/v1/relations/${encodeURIComponent(relationId)}`, {
        follow_supersession: followSupersession,
      }),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------

  /** The active schema document, or a clean 404 when none is declared. */
  async getSchema(
    opts: { namespace?: string; version?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/schema", opts), undefined);
  }

  /** Validate a schema document WITHOUT storing it. */
  async validateSchema(
    document: string,
    scope?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/schema/validate",
      compact({ schema_document: document, scope }),
    );
  }

  /** Upload (merge) a schema document. */
  /**
   * REPLACE the active schema rather than merging into it.
   *
   * `force_drop_existing` consents to dropping declarations the new document
   * omits — and the rows bound to them go with their declaration. Upload
   * merges; this is the verb that can remove.
   */
  async replaceSchema(
    document: string,
    opts: { force_drop_existing: boolean; scope?: string },
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PUT",
      "/v1/schema",
      compact({
        schema_document: document,
        force_drop_existing: opts.force_drop_existing,
        scope: opts.scope,
      }),
    );
  }

  async uploadSchema(
    document: string,
    opts: SchemaOptions & { scope?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/schema",
      compact({
        schema_document: document,
        dry_run: opts.dry_run,
        allow_breaking: opts.allow_breaking,
        scope: opts.scope,
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Entity lifecycle
  //
  // The typed graph was write-once without these: an entity could be created
  // and read, never corrected. `merge`/`unmerge` in particular are how a graph
  // stays usable — extraction produces duplicates, and a duplicate that cannot
  // be folded in is a permanent split in everything that traverses it.
  // ---------------------------------------------------------------------

  /** Replace an entity's name, aliases and attributes wholesale.
   *
   *  PUT, not PATCH, on the wire too: `ENTITY_UPDATE` replaces, so an omitted
   *  `aliases` CLEARS the list rather than leaving it alone. Read the entity
   *  first and send the whole thing back. */
  async updateEntity(
    entityId: string,
    canonicalName: string,
    opts: { aliases?: string[]; attributes?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("PUT", `/v1/entities/${encodeURIComponent(entityId)}`, {
      canonical_name: canonicalName,
      ...opts,
    });
  }

  /** Rename an entity, keeping the old name as an alias by default.
   *
   *  The default matters: a name an entity was known by is how a later mention
   *  still resolves to it, so dropping it silently breaks resolution for text
   *  that predates the rename. */
  async renameEntity(
    entityId: string,
    newCanonicalName: string,
    moveToAlias?: boolean,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/entities/${encodeURIComponent(entityId)}/rename`, {
      new_canonical_name: newCanonicalName,
      ...(moveToAlias === undefined ? {} : { move_to_alias: moveToAlias }),
    });
  }

  /** Fold `merged` into `survivor`. The path id is the one that REMAINS. */
  async mergeEntities(
    survivorId: string,
    mergedId: string,
    opts: { confidence?: number; reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/entities/${encodeURIComponent(survivorId)}/merge`, {
      merged: mergedId,
      ...opts,
    });
  }

  /** Pull an entity back out of the survivor it was merged into. */
  async unmergeEntity(entityId: string): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/entities/${encodeURIComponent(entityId)}/unmerge`,
      {},
    );
  }

  /** Tombstone an entity. Soft: it stops appearing in listings, and the rows
   *  that referenced it keep referring to something that still exists. */
  async deleteEntity(
    entityId: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      withQuery(`/v1/entities/${encodeURIComponent(entityId)}`, { reason }),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Statement authoring
  //
  // Without these a caller could only ever see what the extractor decided,
  // never correct it. `supersede` is the one that carries the product claim:
  // it keeps both versions and the link between them, so "what did we believe
  // last week" survives the correction.
  // ---------------------------------------------------------------------

  /** Assert a claim directly.
   *
   *  `eventAt` is when the thing HAPPENED; `validFrom`/`validTo` are when the
   *  claim is held to be true. A meeting held on Monday and believed from
   *  Tuesday has different values for the two, and collapsing them is how
   *  bi-temporal data stops being bi-temporal. */
  async createStatement(body: StatementBody): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/statements", body);
  }

  /** Replace a claim with a revised one, keeping both and the link between
   *  them. The replacement is a whole statement, not a patch. */
  async supersedeStatement(
    statementId: string,
    body: StatementBody,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/statements/${encodeURIComponent(statementId)}/supersede`,
      body,
    );
  }

  /** Soft-tombstone a claim, keeping the row for audit. */
  async deleteStatement(
    statementId: string,
    opts: { reason?: number; message?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      withQuery(`/v1/statements/${encodeURIComponent(statementId)}`, opts),
      undefined,
    );
  }

  /** Retract a claim — the content does not survive.
   *
   *  A separate verb from delete because the two differ in whether the content
   *  survives, which is not a difference to hide in a flag. */
  async retractStatement(
    statementId: string,
    opts: { reason?: number; message?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      withQuery(`/v1/statements/${encodeURIComponent(statementId)}/retract`, opts),
      {},
    );
  }

  /** The full supersession chain for a claim, oldest to newest. */
  async statementHistory(
    statementId: string,
    opts: StatementHistoryOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      withQuery(`/v1/statements/${encodeURIComponent(statementId)}/history`, opts),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Relation authoring
  // ---------------------------------------------------------------------

  /** Assert a typed edge between two entities. */
  async createRelation(body: RelationBody): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/relations", body);
  }

  /** Replace an edge with a revised one, keeping the chain. */
  async supersedeRelation(
    relationId: string,
    body: RelationBody,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/relations/${encodeURIComponent(relationId)}/supersede`,
      body,
    );
  }

  /** Tombstone an edge. */
  async deleteRelation(
    relationId: string,
    opts: { reason?: number; message?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      withQuery(`/v1/relations/${encodeURIComponent(relationId)}`, opts),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Schema introspection
  // ---------------------------------------------------------------------

  /** Page through the schema's version history — distinct from `getSchema`,
   *  which returns one document. */
  async listSchemaVersions(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/schemas", opts), undefined);
  }

  /** The extractors registered for this namespace. Read-only: extraction is
   *  always on and cannot be toggled. */
  async listExtractors(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/extractors", undefined);
  }

  /** The entity types this workspace can use, with their numeric ids. */
  async listEntityTypes(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/entity-types", undefined);
  }

  /** Drop one declared predicate or relation type.
   *
   *  `kind` is `predicate` or `relation_type` and nothing else — entity types
   *  are global in the v1 storage model, so dropping one would race rows in
   *  other namespaces that share it.
   *
   *  `force` is not a "yes I'm sure" flag. It is specifically consent to
   *  orphan live rows, which survive as plain memories no longer enriched from
   *  the typed-graph tables. Without live rows the drop needs no force. */
  async dropSchemaType(
    kind: string,
    name: string,
    opts: { force?: boolean; scope?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      withQuery(
        `/v1/schema/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
        opts,
      ),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Query introspection
  // ---------------------------------------------------------------------

  /** Plan a query without running it. */
  async explainQuery(
    text: string,
    opts: QueryOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/query/explain", compact({ text, ...opts }));
  }

  /** Run a query and report what each stage actually cost. The query RUNS. */
  async traceQuery(
    text: string,
    opts: QueryOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/query/trace", compact({ text, ...opts }));
  }

  // ---------------------------------------------------------------------
  // Procedural memory
  // ---------------------------------------------------------------------

  /** Render this workspace's stored directives into a system-prompt block. */
  async materialiseDirectives(
    opts: {
      sessions?: number[];
      top_k?: number;
      min_confidence?: number;
      categories?: string[];
    } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/procedural/materialize", opts);
  }

  // ---------------------------------------------------------------------
  // Sessions and spaces
  //
  // Only the non-destructive half. `POST`/`DELETE /v1/spaces` are absent on
  // purpose: neither takes a path parameter, because all three space verbs act
  // on the CALLER'S OWN space, which Brain resolves from `act_as`. A delete is
  // therefore not "remove a space" but "erase this workspace", from one tool
  // call, with no id to get wrong and nothing to undo it.
  // ---------------------------------------------------------------------

  /** Provision a session. Idempotent on the client-chosen id. */
  async createSession(
    sessionId: number,
    title?: string,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/sessions", {
      session_id: sessionId,
      ...(title === undefined ? {} : { title }),
    });
  }

  /** Page through this space's sessions. */
  async listSessions(limit?: number): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/sessions", { limit }), undefined);
  }

  /** Retire a session. Soft by default; `hard` erases it. */
  async deleteSession(
    sessionId: number,
    hard?: boolean,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      withQuery(`/v1/sessions/${encodeURIComponent(String(sessionId))}`, { hard }),
      undefined,
    );
  }

  /** List the spaces this credential can see. */
  async listSpaces(limit?: number): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/spaces", { limit }), undefined);
  }

  /** Create a space under the caller's namespace. */
  async createSpace(metadata?: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/spaces", compact({ metadata }));
  }

  // ---------------------------------------------------------------------
  // Capabilities and BYOK credential
  // ---------------------------------------------------------------------

  /** What this shard supports — limits, enabled tiers, versions. */
  async capabilities(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/capabilities", undefined);
  }

  /** Which provider key is installed. Returns provider/model/fingerprint —
   *  never the key itself; the response shape has no field for one. */
  async getLlmCredential(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/llm-credential", undefined);
  }

  /**
   * Register (or replace) this tenant's provider key.
   *
   * `apiKey` is a live secret. It is a parameter rather than something this
   * method reads, so the one place that touches the environment is the tool
   * handler — and the value never passes through a tool ARGUMENT, which is
   * what would put it in the model's context.
   *
   * The edge verifies the key with the provider before storing it, so a
   * typo fails here rather than on every later write with an opaque 401.
   */
  async putLlmCredential(
    provider: string,
    model: string,
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request("PUT", "/v1/llm-credential", {
      provider,
      model,
      api_key: apiKey,
    });
  }

  /** Probe a key against its provider WITHOUT storing it or touching the
   *  one already registered. */
  async testLlmCredential(
    provider: string,
    model: string,
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/llm-credential/test", {
      provider,
      model,
      api_key: apiKey,
    });
  }

  /** Revoke this tenant's provider key. Reports whether anything was
   *  removed, so "revoked" and "there was nothing there" stay distinct. */
  async deleteLlmCredential(): Promise<Record<string, unknown>> {
    return this.request("DELETE", "/v1/llm-credential", undefined);
  }

  /** Re-probe the key already installed, by asking the provider.
   *
   *  No argument and no secret in flight: unlike `POST /v1/llm-credential/test`
   *  — which takes a RAW provider key in its body and is therefore not a tool —
   *  this checks the stored one. A key that worked at registration can be
   *  revoked later, and without this the first sign is an opaque upstream 401
   *  on a write. */
  async verifyLlmCredential(): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/llm-credential/verify", {});
  }

  /**
   * Read a BOUNDED slice of the change feed and return it.
   *
   * `GET /v1/subscribe` is Server-Sent Events: it opens and stays open. MCP
   * tools are request/response, so the stream is drained to a deadline and a
   * count, then closed, and the last LSN comes back so the next call resumes
   * where this one stopped. That makes "follow the feed" a loop the AGENT
   * drives, which is the only shape a request/response tool can honestly
   * offer — a tool that promised to stream would simply hang.
   *
   * Ends at whichever comes first: `maxEvents`, `waitMs`, or the server
   * closing. Returning early with nothing is a normal outcome, not an error:
   * a quiet feed has no events to report.
   */
  async drainEvents(
    opts: {
      from_lsn?: number;
      sessions?: string;
      kinds?: string;
      memories?: string;
      include_history?: boolean;
    },
    maxEvents: number,
    waitMs: number,
  ): Promise<{ events: unknown[]; last_lsn: number | null; truncated: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    const path = withQuery("/v1/subscribe", opts);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.backendUrl}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.credential}`,
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return { events: [], last_lsn: null, truncated: false };
      }
      throw new BackendError(502, `subscribe failed: ${String(err)}`);
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw new BackendError(res.status, await res.text());
    }

    const events: unknown[] = [];
    let lastLsn: number | null = null;
    let truncated = false;
    const reader = res.body?.getReader();
    if (reader === undefined) {
      clearTimeout(timer);
      return { events, last_lsn: lastLsn, truncated };
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (events.length < maxEvents) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; `id:` carries the LSN
        // and `data:` the JSON payload.
        let split = buffer.indexOf("\n\n");
        while (split !== -1 && events.length < maxEvents) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          const id = frame
            .split("\n")
            .find((l) => l.startsWith("id:"))
            ?.slice(3)
            .trim();
          if (id !== undefined && /^\d+$/.test(id)) lastLsn = Number(id);
          if (data !== "") {
            try {
              events.push(JSON.parse(data));
            } catch {
              events.push({ raw: data });
            }
          }
          split = buffer.indexOf("\n\n");
        }
      }
      truncated = events.length >= maxEvents;
    } catch (err) {
      // An abort is the deadline doing its job, not a failure.
      if (!(err instanceof Error && err.name === "AbortError")) throw err;
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
    }
    return { events, last_lsn: lastLsn, truncated };
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.credential}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.backendUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new BackendError(504, `request to ${path} timed out`);
      }
      throw new BackendError(502, `request to ${path} failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new BackendError(res.status, text);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
