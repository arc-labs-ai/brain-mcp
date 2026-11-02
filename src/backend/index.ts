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
function withQuery(path: string, params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
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
  async remember(content: string): Promise<RememberResult> {
    return this.request<RememberResult>("POST", "/v1/memories", {
      text: content,
    });
  }

  /** Recall the current, consistent truth for the caller against `query`. */
  async recall(query: string, maxResults?: number): Promise<RecallResult> {
    const body: Record<string, unknown> = { query };
    if (maxResults !== undefined) body.max_results = maxResults;
    return this.request<RecallResult>("POST", "/v1/recall", body);
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
  async listMemories(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/memories", opts), undefined);
  }

  /** Full detail for one memory: the extracted graph, provenance, scoring. */
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
    maxSteps?: number,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      start: { text: start },
      goal: { text: goal },
    };
    if (maxSteps !== undefined) body.max_steps = maxSteps;
    return this.request("POST", "/v1/plan", body);
  }

  /** Infer over the stored graph from an observation. */
  async reason(observation: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/reason", {
      observation: { text: observation },
    });
  }

  // ---------------------------------------------------------------------
  // Graph edges
  // ---------------------------------------------------------------------

  /** Link two memories with a typed edge. */
  async link(
    source: string,
    target: string,
    kind: string,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/links", { source, target, kind });
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
  async graph(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/graph", opts), undefined);
  }

  // ---------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------

  /** Create an entity of a declared type. */
  async createEntity(
    entityTypeId: number,
    canonicalName: string,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/entities", {
      entity_type_id: entityTypeId,
      canonical_name: canonicalName,
    });
  }

  /** List entities. `entity_type_id` is required by the edge — a list across
   *  every type is refused rather than silently paged. */
  async listEntities(
    entityTypeId: number,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      withQuery("/v1/entities", { entity_type_id: entityTypeId, ...opts }),
      undefined,
    );
  }

  /** Resolve a surface form to an existing entity (or report no match). */
  async resolveEntity(candidateName: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/entities/resolve", {
      candidate_name: candidateName,
    });
  }

  /** One entity by id. */
  async getEntity(entityId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/entities/${encodeURIComponent(entityId)}`, undefined);
  }

  /** Walk the relation graph outward from an entity. */
  async traverseEntity(
    entityId: string,
    opts: { depth?: number; limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/entities/${encodeURIComponent(entityId)}/traverse`,
      opts,
    );
  }

  /** Relations attached to an entity. */
  async entityRelations(
    entityId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      withQuery(`/v1/entities/${encodeURIComponent(entityId)}/relations`, opts),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Statements and relations
  // ---------------------------------------------------------------------

  /** List statements (subject–predicate–object facts). */
  async listStatements(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("GET", withQuery("/v1/statements", opts), undefined);
  }

  /** One statement by id. */
  async getStatement(statementId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/statements/${encodeURIComponent(statementId)}`,
      undefined,
    );
  }

  /** One relation by id. */
  async getRelation(relationId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/relations/${encodeURIComponent(relationId)}`,
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------

  /** The active schema document, or a clean 404 when none is declared. */
  async getSchema(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/schema", undefined);
  }

  /** Validate a schema document WITHOUT storing it. */
  async validateSchema(document: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/schema/validate", {
      schema_document: document,
    });
  }

  /** Upload (merge) a schema document. */
  async uploadSchema(document: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/schema", { schema_document: document });
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
  async statementHistory(statementId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/statements/${encodeURIComponent(statementId)}/history`,
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
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      withQuery(`/v1/relations/${encodeURIComponent(relationId)}`, { reason }),
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
    force?: boolean,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      withQuery(`/v1/schema/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, {
        force,
      }),
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Query introspection
  // ---------------------------------------------------------------------

  /** Plan a query without running it. */
  async explainQuery(text: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/query/explain", { text });
  }

  /** Run a query and report what each stage actually cost. The query RUNS. */
  async traceQuery(text: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/query/trace", { text });
  }

  // ---------------------------------------------------------------------
  // Procedural memory
  // ---------------------------------------------------------------------

  /** Render this workspace's stored directives into a system-prompt block. */
  async materialiseDirectives(
    opts: { top_k?: number; min_confidence?: number; categories?: string[] } = {},
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
