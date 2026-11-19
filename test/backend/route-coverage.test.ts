/**
 * Guards the one property the rest of the suite cannot see: every operation
 * Brain exposes is reachable through this server.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Route {
  method: string;
  path: string;
}

interface RouteSnapshot {
  source: string;
  generated_from: number;
  routes: Route[];
  fields: string[];
}

// `max_inflight` tunes how far ahead of a slow reader Brain may run; drainEvents
// reads to a deadline and closes immediately, so the server default is correct
// and Brain clamps it anyway.
// `move_to_alias` is accepted by Brain, but `rename` with move_to_alias=false
// is not yet supported (400), while true is what the server does anyway, so
// the tool does not offer a value that would be useful to send.
const EXEMPT_PARAMETER_NAMES = new Set(["max_inflight", "move_to_alias"]);

function readTypeScriptFiles(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return [readTypeScriptFiles(path)];
      return entry.isFile() && entry.name.endsWith(".ts")
        ? [readFileSync(path, "utf8")]
        : [];
    })
    .join("\n");
}

function routeKey(route: Route): string {
  return `${route.method} ${route.path}`;
}

function extractClientRoutes(source: string): Set<string> {
  const routes = new Set<string>();
  const methodPattern =
    /(?:"(GET|POST|PUT|DELETE|PATCH)"\s*,|method:\s*"(GET|POST|PUT|DELETE|PATCH)")/g;
  const pathPattern = /[`"](\/v1\/[^`"]*)/;

  for (const match of source.matchAll(methodPattern)) {
    const method = match[1] ?? match[2];
    const start = match.index + match[0].length;
    const after = source.slice(start, start + 300).match(pathPattern);
    const before =
      after === null
        ? source.slice(Math.max(0, match.index - 300), match.index).match(pathPattern)
        : null;
    const path = after?.[1] ?? before?.[1];
    if (path === undefined) continue;
    routes.add(`${method} ${path.replace(/\$\{[^}]+\}/g, "{id}")}`);
  }

  return routes;
}

describe("Brain route coverage", () => {
  it("keeps every contract route reachable through the backend client", () => {
    const source = readFileSync(
      new URL("../../src/backend/index.ts", import.meta.url),
      "utf8",
    );
    const snapshot = JSON.parse(
      readFileSync(new URL("../../contract/brain-routes.json", import.meta.url), "utf8"),
    ) as RouteSnapshot;
    const clientRoutes = extractClientRoutes(source);
    const snapshotRoutes = new Set(snapshot.routes.map(routeKey));

    expect(clientRoutes.size).toBeGreaterThan(50);

    const missingFromClient = [...snapshotRoutes]
      .filter((route) => !clientRoutes.has(route))
      .sort();
    expect(
      missingFromClient,
      `The MCP surface is missing these Brain routes: ${missingFromClient.join(", ")}`,
    ).toEqual([]);

    const missingFromSnapshot = [...clientRoutes]
      .filter((route) => !snapshotRoutes.has(route))
      .sort();
    expect(
      missingFromSnapshot,
      `The client calls routes not in the snapshot; re-run the refresh script: ${missingFromSnapshot.join(", ")}`,
    ).toEqual([]);
  });

  /** The route test proves every OPERATION is reachable; this proves every PARAMETER of those operations is. */
  it("keeps every contract parameter reachable through the backend client", () => {
    const source = readTypeScriptFiles(new URL("../../src", import.meta.url).pathname);
    const snapshot = JSON.parse(
      readFileSync(new URL("../../contract/brain-routes.json", import.meta.url), "utf8"),
    ) as RouteSnapshot;
    const staleExemptions = [...EXEMPT_PARAMETER_NAMES]
      .filter((field) => !snapshot.fields.includes(field))
      .sort();
    expect(
      staleExemptions,
      `The exemption lists a parameter Brain no longer accepts, so it should be removed: ${staleExemptions.join(", ")}`,
    ).toEqual([]);
    // A comment explaining an omission must not read as the omission being undone.
    const sourceWithoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const usedExemptions = [...EXEMPT_PARAMETER_NAMES]
      .filter((field) => new RegExp(`\\b${field}\\b`).test(sourceWithoutComments))
      .sort();
    expect(
      usedExemptions,
      `The exemption claims these parameters are unreachable, but the code uses them: ${usedExemptions.join(", ")}`,
    ).toEqual([]);

    const nonIdentifierFields = snapshot.fields.filter(
      (field) => !/^[a-z][a-z0-9_]*$/.test(field),
    );
    expect(
      nonIdentifierFields,
      `Contract parameter names must be identifiers before they can be matched: ${nonIdentifierFields.join(", ")}`,
    ).toEqual([]);
    const missingFields = snapshot.fields
      .filter((field) => !EXEMPT_PARAMETER_NAMES.has(field))
      .filter((field) => !new RegExp(`\\b${field}\\b`).test(source))
      .sort();

    expect(
      missingFields,
      `A parameter Brain accepts is not reachable through any tool: ${missingFields.join(", ")}`,
    ).toEqual([]);
  });
});
