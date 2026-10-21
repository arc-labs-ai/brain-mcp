/**
 * The error contract. `fail` is the single place a backend condition becomes
 * text an agent reads, so what it says decides whether the agent retries, asks
 * the user to change something, or tells the user their data was lost.
 *
 * These assert the parts that change behaviour: the code is identified from
 * the real wire shape, the retry verdict matches the condition, and the two
 * conditions that are easy to confuse — a missing provider key (terminal,
 * needs an admin) and a briefly unreachable one (transient, needs nothing) —
 * never render as each other.
 */

import { describe, expect, it } from "vitest";
import { BackendError } from "../../src/backend/index.js";
import { KNOWN_PROBLEM_CODES, fail } from "../../src/server/result.js";

/** Wrap a code the way `brain-edge`'s `ErrorBody` serialises it. */
function wire(code: string, message = "detail from brain"): string {
  return JSON.stringify({ error: { code, message } });
}

function textOf(err: unknown): string {
  const res = fail(err);
  expect(res.isError).toBe(true);
  return (res.content[0] as { text: string }).text;
}

/**
 * Every code `brain-edge` can put on the wire, transcribed from its
 * `src/error/mod.rs` with the status each one carries. This list is the
 * contract; if the edge grows a code, this test fails until the guidance table
 * is taught about it — which is the point, because an untaught code degrades
 * to a status-only guess at whether retrying helps.
 */
const EDGE_CODES: ReadonlyArray<[code: string, status: number]> = [
  ["unauthorized", 401],
  ["forbidden", 403],
  ["bad_request", 400],
  ["not_found", 404],
  ["conflict", 409],
  ["llm_credential.missing", 409],
  ["llm_credential.unavailable", 503],
  ["engine.unavailable", 503],
  ["engine.error", 502],
  ["upstream.error", 502],
  ["not_implemented", 501],
  ["internal", 500],
];

describe("fail() error contract", () => {
  it("has guidance for every code brain-edge can emit, and no others", () => {
    expect([...KNOWN_PROBLEM_CODES].sort()).toEqual(EDGE_CODES.map(([c]) => c).sort());
  });

  it("renders a code, a retry verdict and a fix for each of them", () => {
    for (const [code, status] of EDGE_CODES) {
      const text = textOf(new BackendError(status, wire(code)));
      expect(text, code).toContain(`code: ${code} http ${status}`);
      expect(text, code).toMatch(/^retry: (no|yes|maybe)\b/m);
      expect(text, code).toMatch(/^fix: \S/m);
      expect(text, code).not.toContain("(unrecognised)");
      // The backend's own message is the headline; it describes this request.
      expect(text, code).toContain("error: detail from brain");
    }
  });

  it("marks a missing provider key terminal and names who fixes it", () => {
    const text = textOf(new BackendError(409, wire("llm_credential.missing", "no key")));
    expect(text).toContain("no LLM provider key configured");
    expect(text).toContain("Settings → Providers");
    expect(text).toMatch(/^retry: no\b/m);
  });

  it("does not tell the operator to add a key when the key is merely unreachable", () => {
    // 'missing' and 'unavailable' differ by one word and by everything that
    // matters: one needs an admin, the other needs a few seconds. Rendering
    // the transient one as the terminal one sends an operator to configure a
    // key they already hold, and stops the agent retrying a write that would
    // have succeeded.
    const text = textOf(new BackendError(503, wire("llm_credential.unavailable")));
    expect(text).toMatch(/^retry: yes\b/m);
    expect(text).not.toContain("Settings → Providers");
    expect(text).not.toContain("no LLM provider key configured");
  });

  it("does not mistake an ordinary conflict for a missing key", () => {
    const text = textOf(new BackendError(409, wire("conflict")));
    expect(text).not.toContain("no LLM provider key configured");
    expect(text).toMatch(/^retry: no\b/m);
  });

  it("calls a rejected request terminal and an unavailable engine transient", () => {
    expect(textOf(new BackendError(400, wire("bad_request")))).toMatch(/^retry: no\b/m);
    expect(textOf(new BackendError(503, wire("engine.unavailable")))).toMatch(
      /^retry: yes\b/m,
    );
  });

  it("does not match a code that only appears inside the message", () => {
    // The previous implementation substring-searched the whole body, so a
    // message *mentioning* a code was read as that code.
    const text = textOf(
      new BackendError(
        409,
        wire("conflict", "could not resolve llm_credential.missing for this namespace"),
      ),
    );
    expect(text).toContain("code: conflict http 409");
    expect(text).not.toContain("Settings → Providers");
  });

  it("reads a bare problem body as well as the wrapped one", () => {
    const text = textOf(new BackendError(404, JSON.stringify({ code: "not_found" })));
    expect(text).toContain("code: not_found http 404");
  });

  it("flags a code it has not been taught instead of guessing silently", () => {
    const text = textOf(new BackendError(451, wire("policy.blocked")));
    expect(text).toContain("code: policy.blocked (unrecognised) http 451");
    expect(text).toMatch(/^retry: no\b/m);
  });

  it("falls back to the status when there is no parseable problem body", () => {
    const text = textOf(new BackendError(500, "<html>502 Bad Gateway</html>"));
    expect(text).toContain("code: (none) http 500");
    expect(text).toMatch(/^retry: /m);
  });

  it("warns that a timed-out write may still have landed", () => {
    // The client mints this one itself: the request was abandoned, so whether
    // Brain applied it is genuinely unknown. An agent told only 'timed out'
    // will re-send and duplicate the memory.
    const text = textOf(new BackendError(504, "request to /v1/memories timed out"));
    expect(text).toMatch(/^retry: yes\b/m);
    expect(text).toContain("may or may not have landed");
  });

  it("points at configuration, not the call, when the service key is rejected", () => {
    const text = textOf(new BackendError(401, wire("unauthorized")));
    expect(text).toContain("BRAIN_API_KEY");
    expect(text).toMatch(/^retry: no\b/m);
  });

  it("survives a non-BackendError without throwing", () => {
    expect(textOf(new Error("boom"))).toContain("error: boom");
    expect(textOf("a bare string")).toContain("a bare string");
  });
});
