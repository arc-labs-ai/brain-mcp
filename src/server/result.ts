/**
 * How a tool call is rendered back to the agent, and the one input every tool
 * shares.
 *
 * Kept apart from the tool definitions so the error contract is stated once:
 * every tool funnels failures through `fail`, so a backend condition is
 * described the same way no matter which tool hit it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BackendError } from "../backend/index.js";

/** Render a successful tool result as pretty JSON text content. */
export function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * A failure body, from either of the two backends brain-mcp supports.
 *
 * They do NOT share a shape, despite both serving `/v1/*`:
 *
 *   brain-edge  {"error": {"code": "...", "message": "..."}}
 *   gateway     RFC 7807 — {"type","title","status","code","detail","trace_id"}
 *
 * and they barely share a vocabulary: twelve codes against eighteen, with
 * three in common. Reading only the edge's shape left every gateway failure
 * rendered as raw JSON with an unrecognised code — on the deployment the
 * README calls the intended one.
 *
 * Parsed rather than string-matched: a substring search finds a code inside
 * an unrelated message too, and would read `"could not resolve
 * llm_credential.missing"` as the condition itself.
 */
interface Problem {
  code: string;
  message: string;
  /** Request id to quote when asking an operator to look in the logs. */
  traceId?: string;
  /** Seconds the server asked us to wait (429/503). */
  retryAfter?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readProblem(node: unknown): Problem | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const o = node as Record<string, unknown>;
  const code = str(o.code);
  if (code === undefined) return undefined;
  // `message` is the edge's field; `detail` then `title` are RFC 7807's.
  const message = str(o.message) ?? str(o.detail) ?? str(o.title) ?? "";
  const retry = o.retry_after;
  return {
    code,
    message,
    traceId: str(o.trace_id) ?? str(o.request_id),
    retryAfter: typeof retry === "number" && Number.isFinite(retry) ? retry : undefined,
  };
}

function parseProblem(body: string): Problem | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  // Wrapped (edge) first, then flat (gateway, and anything proxying in front).
  return readProblem((parsed as { error?: unknown }).error) ?? readProblem(parsed);
}

/**
 * Whether retrying the identical call can succeed. This is the single most
 * important thing to tell an agent: left to guess, an agent either retries a
 * terminal failure in a loop or gives up on a transient one and reports to the
 * user that Brain lost their data.
 */
type Retry = "never" | "soon" | "once";

const RETRY_TEXT: Record<Retry, string> = {
  never: "no — this call will fail identically until the cause below is fixed",
  soon: "yes — this is transient; retry after a short delay",
  once: "maybe — retry once; if it repeats, the cause is not transient",
};

/**
 * Guidance per problem code, across BOTH backends.
 *
 * `brain-edge` (`src/error/mod.rs`) emits twelve codes; the gateway
 * (`services/gateway/src/error/api_error.rs`) emits eighteen. Only
 * `engine.error`, `engine.unavailable` and `llm_credential.missing` are
 * shared, so a table built from one backend leaves the other almost entirely
 * unrecognised. This is the agent-facing half of both contracts: a code added
 * to either belongs here, and `errors.test.ts` fails until it is.
 */
const PROBLEMS: Record<string, { retry: Retry; fix: string }> = {
  unauthorized: {
    retry: "never",
    fix:
      "the service key this MCP server authenticates with was rejected. An " +
      "operator needs to check BRAIN_API_KEY; nothing about the tool call " +
      "itself is wrong.",
  },
  forbidden: {
    retry: "never",
    fix:
      "the service key is valid but not permitted on this namespace or " +
      "customer scope. An operator needs to widen the key's grant.",
  },
  bad_request: {
    retry: "never",
    fix:
      "Brain rejected the arguments. Re-read the tool's schema and correct " +
      "them — the message above says what was wrong. Retrying unchanged will " +
      "not help.",
  },
  not_found: {
    retry: "never",
    fix:
      "no such record in this customer's scope. Confirm the id, and that it " +
      "belongs to the customer_id passed — ids are not shared across " +
      "customers.",
  },
  conflict: {
    retry: "never",
    fix:
      "the request conflicts with this customer's current state. Read the " +
      "current state before writing again rather than retrying.",
  },
  "llm_credential.missing": {
    retry: "never",
    fix:
      "this workspace has no LLM provider key configured. Brain extracts " +
      "typed facts and generates retrieval questions on every write, both " +
      "of which need a provider key, so it refuses the write rather than " +
      "saving text it cannot ground. Retrying will not help, and neither " +
      "will rephrasing: a workspace admin needs to add an OpenAI or " +
      "Anthropic key in the Arc Labs dashboard under Settings → Providers.",
  },
  "llm_credential.unavailable": {
    retry: "soon",
    fix:
      "the provider key is registered but the broker could not be reached " +
      "just now. This is not a configuration problem — do not tell the user " +
      "to add a key.",
  },
  "engine.unavailable": {
    retry: "soon",
    fix: "the memory engine is restarting or saturated. No action needed.",
  },
  "engine.error": {
    retry: "once",
    fix:
      "the memory engine returned an error it classified as its own fault. " +
      "The detail was withheld from this response and is in the edge's log " +
      "under this request's id.",
  },
  "upstream.error": {
    retry: "once",
    fix:
      "a service the edge depends on failed. The detail is deliberately thin " +
      "(upstream errors can echo credentials) and is in the edge's log.",
  },
  not_implemented: {
    retry: "never",
    fix:
      "this edge was not configured with the capability the call needs — for " +
      "BYOK, that means no key-encryption key is set. It needs configuration, " +
      "not a retry.",
  },
  internal: {
    retry: "never",
    fix:
      "the edge could not classify the fault. Report this with the request id " +
      "from the edge's log; retrying is unlikely to behave differently.",
  },
  // ---- gateway only (RFC 7807 problem documents) --------------------------
  "auth.missing_key": {
    retry: "never",
    fix:
      "no API key reached the gateway. The MCP server sends BRAIN_API_KEY as " +
      "a bearer token; an operator needs to check it is set and that nothing " +
      "in front is stripping the header.",
  },
  "auth.invalid_key": {
    retry: "never",
    fix:
      "the gateway does not recognise this API key, or it has been revoked. " +
      "An operator needs to issue a new one; the tool call itself is fine.",
  },
  "auth.forbidden": {
    retry: "never",
    fix:
      "the key is valid but not permitted on this customer scope. An operator " +
      "needs to widen its grant.",
  },
  "auth.unavailable": {
    retry: "soon",
    fix:
      "the gateway could not reach its own auth store to check the key. The " +
      "key is probably fine — this is the gateway's dependency, not yours.",
  },
  rate_limited: {
    retry: "soon",
    fix:
      "this customer is over its request allowance. Back off and spread the " +
      "calls out; a burst of retries makes it worse.",
  },
  "idempotency.conflict": {
    retry: "never",
    fix:
      "an earlier request reused this idempotency key with different " +
      "parameters. Do not retry — a retry must carry the same parameters as " +
      "the first attempt, or a fresh key.",
  },
  "resource.not_found": {
    retry: "never",
    fix:
      "no such record in this customer's scope. Confirm the id, and that it " +
      "belongs to the customer_id passed.",
  },
  "resource.conflict": {
    retry: "never",
    fix:
      "the request conflicts with this customer's current state — a duplicate " +
      "canonical name being the usual cause. Read the current state before " +
      "writing again rather than retrying.",
  },
  "request.malformed": {
    retry: "never",
    fix:
      "the gateway could not parse the request. Re-read the tool's schema and " +
      "correct the arguments; the message above says what was wrong.",
  },
  "request.unsupported_media": {
    retry: "never",
    fix:
      "the gateway rejected the content type. This is a deployment problem, " +
      "not an argument problem — report it rather than retrying.",
  },
  "validation.failed": {
    retry: "never",
    fix:
      "the arguments were well-formed but invalid. The message above names the " +
      "offending field; correct it rather than retrying.",
  },
  "server.overloaded": {
    retry: "soon",
    fix: "the gateway is shedding load. Back off; no action needed.",
  },
  "server.timeout": {
    retry: "soon",
    fix:
      "the gateway gave up waiting on a downstream. A write may or may not " +
      "have landed — read before writing again.",
  },
  "server.error": {
    retry: "once",
    fix:
      "the gateway failed in a way it could not classify. Quote the trace id " +
      "below when reporting it.",
  },
};

/**
 * Codes are absent on failures this client mints itself (it never reached a
 * Brain handler, so there is no envelope to parse) and on anything a proxy
 * returned instead of Brain.
 */
function fromStatus(status: number): { retry: Retry; fix: string } {
  if (status === 504) {
    return {
      retry: "soon",
      fix:
        "the request exceeded this server's timeout before Brain answered. " +
        "The write may or may not have landed — read before writing again.",
    };
  }
  if (status === 502) {
    return {
      retry: "soon",
      fix:
        "Brain could not be reached at all. An operator should check " +
        "BRAIN_BACKEND_URL and that the edge is running.",
    };
  }
  if (status === 429) {
    return { retry: "soon", fix: "rate limited. Back off before retrying." };
  }
  if (status >= 500) {
    return { retry: "once", fix: "an unclassified server-side failure." };
  }
  return {
    retry: "never",
    fix: "the request was rejected. Correct it rather than retrying it.",
  };
}

/**
 * Render a failed tool call so the agent sees, in order: what happened, which
 * code it was, whether to retry, and who fixes it. Flat labelled lines rather
 * than JSON — this text is read by a model, and the labels survive being
 * quoted back to a user.
 */
export function fail(err: unknown): CallToolResult {
  if (!(err instanceof BackendError)) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `error: ${message}\nretry: ${RETRY_TEXT.once}` }],
      isError: true,
    };
  }

  const problem = parseProblem(err.body);
  const known = problem === undefined ? undefined : PROBLEMS[problem.code];
  const { retry, fix } = known ?? fromStatus(err.status);

  // An unrecognised code is still worth naming: it tells whoever reads the
  // transcript that the edge grew a code this server has not been taught.
  const codeLine =
    problem === undefined
      ? `code: (none) http ${err.status}`
      : known === undefined
        ? `code: ${problem.code} (unrecognised) http ${err.status}`
        : `code: ${problem.code} http ${err.status}`;

  const detail = problem?.message || err.body.slice(0, 500) || "(no detail)";

  // The server's own backoff hint beats our generic wording: an agent that
  // retries a 429 immediately just earns another one.
  const retryLine =
    retry !== "never" && problem?.retryAfter !== undefined
      ? `retry: yes — wait ${problem.retryAfter}s; the server asked for that delay specifically`
      : `retry: ${RETRY_TEXT[retry]}`;

  const lines = [`error: ${detail}`, codeLine, retryLine, `fix: ${fix}`];
  // Carrying the trace id is the difference between "something broke" and a
  // line an operator can actually find. The gateway withholds 5xx detail from
  // the response on purpose and logs it under this id.
  if (problem?.traceId !== undefined) {
    lines.push(`trace_id: ${problem.traceId}`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  };
}

/** Every code {@link fail} renders specific guidance for. Exported for tests. */
export const KNOWN_PROBLEM_CODES = Object.keys(PROBLEMS);

/**
 * The scope travels to Brain as an HTTP header value, and header values are
 * ByteStrings. A non-ASCII id therefore cannot be sent at all: `fetch` throws
 * `Cannot convert argument to a ByteString`, which surfaced to the agent as
 * `request to /v1/memories failed` — a transport error blaming the backend
 * for an input the schema should have caught. Rejecting it here says plainly
 * whose fault it is and which argument to change.
 */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

export const customerId = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    HEADER_SAFE,
    "customer_id must be printable ASCII without spaces (it travels as an " +
      "HTTP header). Map a non-ASCII id to a stable ASCII one — a hash or " +
      "slug — before calling.",
  )
  .describe(
    "Stable id of the end customer / user this memory belongs to. Every tool is " +
      "scoped to one customer so their memories never leak across customers. " +
      "Printable ASCII, no spaces: it is sent as an HTTP header value.",
  );
