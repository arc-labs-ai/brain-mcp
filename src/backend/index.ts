/**
 * Thin HTTP client for the Brain REST surface (`/v1/*`). One instance is shared
 * across all MCP tool invocations; it is stateless apart from the config it
 * closes over. Every method scopes to a `customerId` via the scope headers, so
 * one MCP deployment (one service key) serves many isolated customers.
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
  constructor(private readonly cfg: Config) {}

  /** Ingest text as a memory for `customerId`. */
  async remember(customerId: string, content: string): Promise<RememberResult> {
    return this.request<RememberResult>(customerId, "POST", "/v1/memories", {
      text: content,
    });
  }

  /** Recall the current, consistent truth for `customerId` against `query`. */
  async recall(
    customerId: string,
    query: string,
    maxResults?: number,
  ): Promise<RecallResult> {
    const body: Record<string, unknown> = { query };
    if (maxResults !== undefined) body.max_results = maxResults;
    return this.request<RecallResult>(customerId, "POST", "/v1/recall", body);
  }

  /** Tombstone (soft) or zero (hard) a memory for `customerId`. */
  async forget(
    customerId: string,
    memoryId: string,
    hard: boolean,
  ): Promise<ForgetResult> {
    return this.request<ForgetResult>(customerId, "DELETE", "/v1/memories", {
      memory_id: memoryId,
      hard,
    });
  }

  /** Resolve the effective identity for `customerId`. Falls back to the
   *  configured scope when the backend does not expose `/v1/whoami`. */
  async whoami(customerId: string): Promise<Record<string, unknown>> {
    try {
      return await this.request<Record<string, unknown>>(
        customerId,
        "GET",
        "/v1/whoami",
        undefined,
      );
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) {
        return {
          namespace: this.cfg.namespace,
          customer_id: customerId,
          note: "backend has no /v1/whoami; reporting the configured scope",
        };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Memory reads
  // ---------------------------------------------------------------------

  /** List stored memories for `customerId`, newest first. */
  async listMemories(
    customerId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "GET", withQuery("/v1/memories", opts), undefined);
  }

  /** Full detail for one memory: the extracted graph, provenance, scoring. */
  async inspectMemory(
    customerId: string,
    memoryId: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.request<Record<string, unknown>>(
      customerId,
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
    customerId: string,
    start: string,
    goal: string,
    maxSteps?: number,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      start: { text: start },
      goal: { text: goal },
    };
    if (maxSteps !== undefined) body.max_steps = maxSteps;
    return this.request(customerId, "POST", "/v1/plan", body);
  }

  /** Infer over the stored graph from an observation. */
  async reason(
    customerId: string,
    observation: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "POST", "/v1/reason", {
      observation: { text: observation },
    });
  }

  // ---------------------------------------------------------------------
  // Graph edges
  // ---------------------------------------------------------------------

  /** Link two memories with a typed edge. */
  async link(
    customerId: string,
    source: string,
    target: string,
    kind: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "POST", "/v1/links", { source, target, kind });
  }

  /** Remove a typed edge between two memories. */
  async unlink(
    customerId: string,
    source: string,
    target: string,
    kind: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "DELETE", "/v1/links", { source, target, kind });
  }

  /** A page of the knowledge graph. */
  async graph(
    customerId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "GET", withQuery("/v1/graph", opts), undefined);
  }

  // ---------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------

  /** Create an entity of a declared type. */
  async createEntity(
    customerId: string,
    entityTypeId: number,
    canonicalName: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "POST", "/v1/entities", {
      entity_type_id: entityTypeId,
      canonical_name: canonicalName,
    });
  }

  /** List entities. `entity_type_id` is required by the edge — a list across
   *  every type is refused rather than silently paged. */
  async listEntities(
    customerId: string,
    entityTypeId: number,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      customerId,
      "GET",
      withQuery("/v1/entities", { entity_type_id: entityTypeId, ...opts }),
      undefined,
    );
  }

  /** Resolve a surface form to an existing entity (or report no match). */
  async resolveEntity(
    customerId: string,
    candidateName: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "POST", "/v1/entities/resolve", {
      candidate_name: candidateName,
    });
  }

  /** One entity by id. */
  async getEntity(
    customerId: string,
    entityId: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      customerId,
      "GET",
      `/v1/entities/${encodeURIComponent(entityId)}`,
      undefined,
    );
  }

  /** Walk the relation graph outward from an entity. */
  async traverseEntity(
    customerId: string,
    entityId: string,
    opts: { depth?: number; limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      customerId,
      "POST",
      `/v1/entities/${encodeURIComponent(entityId)}/traverse`,
      opts,
    );
  }

  /** Relations attached to an entity. */
  async entityRelations(
    customerId: string,
    entityId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      customerId,
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
    customerId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "GET", withQuery("/v1/statements", opts), undefined);
  }

  /** One statement by id. */
  async getStatement(
    customerId: string,
    statementId: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      customerId,
      "GET",
      `/v1/statements/${encodeURIComponent(statementId)}`,
      undefined,
    );
  }

  /** One relation by id. */
  async getRelation(
    customerId: string,
    relationId: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      customerId,
      "GET",
      `/v1/relations/${encodeURIComponent(relationId)}`,
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------

  /** The active schema document, or a clean 404 when none is declared. */
  async getSchema(customerId: string): Promise<Record<string, unknown>> {
    return this.request(customerId, "GET", "/v1/schema", undefined);
  }

  /** Validate a schema document WITHOUT storing it. */
  async validateSchema(
    customerId: string,
    document: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "POST", "/v1/schema/validate", {
      schema_document: document,
    });
  }

  /** Upload (merge) a schema document. */
  async uploadSchema(
    customerId: string,
    document: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "POST", "/v1/schema", { schema_document: document });
  }

  /** Replace the schema. `forceDropExisting` DISCARDS declarations and the
   *  rows bound to them — destructive, and deliberately not an agent tool. */
  async replaceSchema(
    customerId: string,
    document: string,
    forceDropExisting: boolean,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "PUT", "/v1/schema", {
      schema_document: document,
      force_drop_existing: forceDropExisting,
    });
  }

  // ---------------------------------------------------------------------
  // Capabilities and BYOK credential
  // ---------------------------------------------------------------------

  /** What this shard supports — limits, enabled tiers, versions. */
  async capabilities(customerId: string): Promise<Record<string, unknown>> {
    return this.request(customerId, "GET", "/v1/capabilities", undefined);
  }

  /** Which provider key is installed. Returns provider/model/fingerprint —
   *  never the key itself; the response shape has no field for one. */
  async getLlmCredential(customerId: string): Promise<Record<string, unknown>> {
    return this.request(customerId, "GET", "/v1/llm-credential", undefined);
  }

  /** Register or rotate this workspace's provider key.
   *
   *  Deliberately NOT exposed as an MCP tool: a tool that writes provider keys
   *  is a prompt-injection target, and an agent has no business holding one.
   *  Present here so an operator-facing caller can use the same client. */
  async putLlmCredential(
    customerId: string,
    provider: string,
    model: string,
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request(customerId, "PUT", "/v1/llm-credential", {
      provider,
      model,
      api_key: apiKey,
    });
  }

  /** Remove this workspace's provider key. Also not an agent tool — revoking
   *  a key stops every write in the workspace. */
  async deleteLlmCredential(customerId: string): Promise<Record<string, unknown>> {
    return this.request(customerId, "DELETE", "/v1/llm-credential", undefined);
  }

  private async request<T>(
    customerId: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.apiKey}`,
      [this.cfg.namespaceHeader]: this.cfg.namespace,
      [this.cfg.scopeHeader]: customerId,
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
