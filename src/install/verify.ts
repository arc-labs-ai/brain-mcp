/**
 * Prove the credential works before writing it anywhere.
 *
 * This is the whole reason `init` is worth more than a documented snippet. A
 * wrong key in a client config does not fail at install time — it fails later,
 * inside an agent turn, as a tool error the user reads as "Brain is broken".
 * One `GET /v1/whoami` here converts that into a sentence at the prompt, next
 * to the thing that caused it.
 *
 * It also turns the check into the confirmation: whoami answers with the
 * namespace and space the key is bound to, so the user sees WHICH Brain they
 * just connected, not merely that something answered.
 */

export interface Identity {
  namespace?: string;
  space?: string;
  /**
   * Capabilities the key does NOT carry, among the ones the MCP tools need.
   *
   * A key can be entirely valid and still be unable to write. Installed, that
   * key fails on the first `remember` — inside an agent turn, as a tool error,
   * long after the thing that could have explained it. It is the same deferred
   * failure a wrong key causes, so it is caught in the same place.
   */
  missing: string[];
  /** Everything the backend said, for a caller that wants more. */
  raw: Record<string, unknown>;
}

/** What the headline tools need: `remember` encodes, `recall` reads. A key
 *  without one of these is not a key you can finish the quickstart with. */
const NEEDED: Record<string, string> = {
  can_encode: "remember",
  can_recall: "recall",
};

export class VerifyError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Pull the first present key, so a contract that renames a field degrades to
 *  a missing line rather than a crash. */
function pick(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export async function verify(
  backendUrl: string,
  apiKey: string,
  timeoutMs = 15000,
): Promise<Identity> {
  const url = `${backendUrl.replace(/\/+$/, "")}/v1/whoami`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new VerifyError(
      `Could not reach ${backendUrl} (${reason}).`,
      "If that is a local brain-edge, start it first. If it is the hosted " +
        "gateway, check the URL and your network.",
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();

  if (res.status === 401 || res.status === 403) {
    // The gateway answers RFC 9457, so there is a machine-readable reason —
    // "unknown or revoked" and "you sent no key" need different fixes.
    let detail = "";
    try {
      const problem = JSON.parse(body) as { detail?: string; code?: string };
      detail = problem.detail ?? problem.code ?? "";
    } catch {
      detail = body.slice(0, 200);
    }
    throw new VerifyError(
      `${backendUrl} rejected that key${detail ? ` (${detail})` : ""}.`,
      "Create or copy one in the dashboard under API Keys, then run init again.",
    );
  }

  if (!res.ok) {
    throw new VerifyError(
      `${backendUrl} answered ${res.status} for /v1/whoami.`,
      "That is not a credential problem — the backend is unhealthy or the URL " +
        "points at something that is not a Brain gateway.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new VerifyError(
      `${backendUrl} answered /v1/whoami with something that is not JSON.`,
      "The URL is probably not a Brain gateway — a proxy or login page will " +
        "do this.",
    );
  }

  const raw = (parsed ?? {}) as Record<string, unknown>;
  // The gateway has wrapped single objects in `{data: …}` on other routes, so
  // unwrap one level rather than assuming which shape this route uses.
  const inner =
    typeof raw.data === "object" && raw.data !== null
      ? (raw.data as Record<string, unknown>)
      : raw;

  // `space_id` is deliberately not read as a display value: the gateway
  // answers with a bare UUID there, and a UUID on a confirmation line is
  // noise. A slug, if one ever appears, is worth showing.
  const perms =
    typeof inner.permissions === "object" && inner.permissions !== null
      ? (inner.permissions as Record<string, unknown>)
      : {};
  const missing = Object.entries(NEEDED)
    // `=== false` and not `!perms[k]`: a backend that stops sending a flag
    // must not read as a key that was refused it.
    .filter(([flag]) => perms[flag] === false)
    .map(([, tool]) => tool);

  return {
    namespace: pick(inner, "namespace", "namespace_slug", "namespace_name"),
    space: pick(inner, "space", "space_slug", "space_name", "agent"),
    missing,
    raw: inner,
  };
}
