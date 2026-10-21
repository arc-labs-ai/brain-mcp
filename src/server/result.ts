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
 * The error envelope every `/v1/*` failure carries:
 * `{"error": {"code": "...", "message": "..."}}` — `brain-edge`'s `ErrorBody`
 * and the gateway's error shape agree on it.
 *
 * Parsed rather than string-matched: a substring search for a code finds it in
 * an unrelated message too, and would read `"could not resolve
 * llm_credential.missing"` as the condition itself.
 */
interface Problem {
  code: string;
  message: string;
}

function readProblem(node: unknown): Problem | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const { code, message } = node as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || code.length === 0) return undefined;
  return { code, message: typeof message === "string" ? message : "" };
}

function parseProblem(body: string): Problem | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  // The wrapped form is the contract. The bare form is accepted too, because
  // a failure can also be rendered by something in front of Brain, and losing
  // the code there would silently demote every such error to the generic
  // status-only path.
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
 * Guidance per problem code. The codes and their statuses are `brain-edge`'s
 * (`src/error/mod.rs`); this table is the agent-facing half of that contract,
 * so a change there belongs here too — the `operations` test asserts every
 * code in this table still renders.
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

  return {
    content: [
      {
        type: "text",
        text: [
          `error: ${detail}`,
          codeLine,
          `retry: ${RETRY_TEXT[retry]}`,
          `fix: ${fix}`,
        ].join("\n"),
      },
    ],
    isError: true,
  };
}

/** Every code {@link fail} renders specific guidance for. Exported for tests. */
export const KNOWN_PROBLEM_CODES = Object.keys(PROBLEMS);

export const customerId = z
  .string()
  .min(1)
  .describe(
    "Stable id of the end customer / user this memory belongs to. Every tool is " +
      "scoped to one customer so their memories never leak across customers.",
  );
