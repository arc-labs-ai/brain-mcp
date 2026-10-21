/**
 * Thin HTTP client for the Brain REST surface (`/v1/*`). One instance is shared
 * across all MCP tool invocations; it is stateless apart from the config it
 * closes over. Every method scopes to a `customerId` via the scope headers, so
 * one MCP deployment (one service key) serves many isolated customers.
 */

import type { Config } from "./config.js";

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
