/**
 * How a tool call is rendered back to the agent, and the one input every tool
 * shares.
 *
 * Kept apart from the tool definitions so the error contract is stated once:
 * every tool funnels failures through `fail`, so a backend condition is
 * described the same way no matter which tool hit it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
 *
 * ⚠️ THE CREDENTIAL IN THESE MESSAGES IS THE CALLER'S, NEVER THIS SERVER'S.
 * The auth entries used to say the opposite — "the service key this MCP
 * server authenticates with was rejected … an operator needs to check
 * BRAIN_API_KEY" — which was left over from the removed shared-service-key
 * mode. Two things were wrong with it once that mode went away. There is no
 * server-held key on the HTTP path at all, so a 401 means the CALLER's key
 * was rejected and the caller is who fixes it; and `BRAIN_API_KEY` is not a
 * variable this server has ever read (it is `BRAIN_MCP_API_KEY`, and only on
 * stdio). An agent following that text sent its user to an operator who had
 * nothing to check, for a key that did not exist, under a name that was not
 * real. `errors.test.ts` now fails on any guidance naming an env var this
 * server does not read.
 */
const PROBLEMS: Record<string, { retry: Retry; fix: string }> = {
  unauthorized: {
    retry: "never",
    fix:
      "the API key this connection presented was rejected. It is YOUR key, not " +
      "the server's: over HTTP it is the `Authorization: Bearer` header your " +
      "MCP client sends, and on stdio it is `BRAIN_MCP_API_KEY` in that " +
      "client's own config. Check it is current and was not revoked; nothing " +
      "about the tool call itself is wrong.",
  },
  forbidden: {
    retry: "never",
    fix:
      "your API key is valid but not permitted on this namespace or " +
      "workspace. A workspace admin needs to widen the key's grant, or you " +
      "need a key bound to the workspace you meant. `whoami` reports which " +
      "one this key actually resolves to.",
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
      "no such record in this workspace. Confirm the id, and that it belongs " +
      "to the workspace your API key is bound to — ids are not shared across " +
      "workspaces.",
  },
  conflict: {
    retry: "never",
    fix:
      "the request conflicts with this workspace's current state. Read the " +
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
      "no API key reached the gateway. This server refuses an uncredentialed " +
      "request with a 401 of its own, so a key that goes missing further on " +
      "means something between here and the gateway stripped the " +
      "`Authorization` header — a proxy or load balancer is the usual cause. " +
      "That is an operator's problem, not yours.",
  },
  "auth.invalid_key": {
    retry: "never",
    fix:
      "the gateway does not recognise the API key you presented, or it has " +
      "been revoked. Issue a new one in the dashboard and update your MCP " +
      "client config; the tool call itself is fine.",
  },
  "auth.forbidden": {
    retry: "never",
    fix:
      "your key is valid but not permitted on this workspace. A workspace " +
      "admin needs to widen its grant, or you need a key bound to the " +
      "workspace you meant — `whoami` reports which one this key resolves to.",
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
      "this workspace is over its request allowance. Back off and spread the " +
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
      "no such record in this workspace. Confirm the id, and that it belongs " +
      "to the workspace your API key is bound to.",
  },
  "resource.conflict": {
    retry: "never",
    fix:
      "the request conflicts with this workspace's current state — a duplicate " +
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
        "BRAIN_MCP_BACKEND_URL and that the backend is running. This one IS " +
        "server configuration — your key is not involved.",
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
