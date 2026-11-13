/**
 * The MCP server definition.
 *
 * This started as four tools (`remember`, `recall`, `forget`, `whoami`) on the
 * explicit reasoning that tool-definition bloat is the top reason agents
 * uninstall an MCP server, with richer typed-graph queries left behind the
 * SDK/REST. That concern has not gone away — it is a real cost, and the four
 * core tools are still the ones most agents need.
 *
 * The surface now covers the edge's whole tenant API because an agent that can
 * only remember and recall cannot follow a fact to its source, walk a relation,
 * or check why a write was refused — it has to guess, and guessing is what the
 * typed graph exists to stop. The tools are grouped below so a reader can see
 * the shape, and each description says when to reach for it rather than
 * restating the endpoint.
 *
 * The surface now covers every tenant route but one. Four that were held
 * back are tools because each found a shape that keeps its hazard out of
 * reach, rather than because the hazard was reconsidered:
 *
 *   - `PUT`/`POST /v1/llm-credential[/test]` take a RAW provider key. The
 *     tools take the NAME of an environment variable instead and read it in
 *     the handler, so the secret never occupies a tool argument — where it
 *     would be written into the model's context and every transcript of the
 *     session. They are registered on stdio only: over HTTP the process
 *     environment is the operator's, not the caller's, so the same argument
 *     would read somebody else's secret. `DELETE` carries no secret and is a
 *     plain tool, marked destructive because revoking stops every write.
 *   - `PUT /v1/schema` replaces rather than merges, and `force_drop_existing`
 *     takes the rows bound to a dropped declaration with it. It is a tool
 *     with that flag REQUIRED and no default, so the destructive choice
 *     cannot be made by omission, and `dry_run` is described as the way to
 *     see what would go first.
 *   - `POST /v1/memories/vector` takes a caller-computed embedding. An agent
 *     cannot produce one, so the description sends it to `remember` and the
 *     tool exists for a client driving this server programmatically.
 *   - `GET /v1/subscribe` is Server-Sent Events, which request/response
 *     cannot represent. The tool drains a BOUNDED slice — to a deadline and
 *     an event count — and returns the resume LSN, making "follow the feed"
 *     a loop the agent drives rather than a tool that hangs.
 *
 * ONE ROUTE STILL HAS NO TOOL. `DELETE /v1/spaces` takes no path parameter,
 * because every space verb acts on the caller's OWN space: it is "erase this
 * workspace" from a single call, with no id that could fail to match and
 * nothing to undo. `create_space` is a tool; the delete stays a deliberate
 * act through the HTTP API.
 *
 * The line is "can a confused or steered agent cause irreversible loss or leak
 * a secret", not "is it a write" — entity merges, statement supersessions and
 * schema drops are all writes and all tools, because each is recoverable,
 * scoped to one record, or both.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrainBackend } from "../backend/index.js";
import { registerCognitiveTools } from "./tools/cognitive.js";
import { registerEntitiesTools } from "./tools/entities.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerQueryTools } from "./tools/query.js";
import { registerSchemaTools } from "./tools/schema.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

const SERVER_NAME = "brain-mcp";
// Reported to the client as `serverInfo.version` on initialize, so it has to
// track package.json. It is hand-written rather than imported because the
// published layout puts package.json outside dist/; release-please stamps it
// via the annotation, which is why this file is in `extra-files`. It had
// already drifted once -- 0.1.1 shipped reporting 0.1.0.
const SERVER_VERSION = "0.4.0"; // x-release-please-version

/**
 * Build a fresh {@link McpServer} wired to `backend`. In stateless HTTP mode a
 * new server is built per request, so this is called on each POST.
 *
 * Registration order is the order an agent sees the tools listed, so the core
 * loop comes first and the introspection surface last.
 */
/**
 * Whether this process's environment belongs to the user.
 *
 * True on stdio, where the MCP client launched this process and its env vars
 * are the user's own. False over HTTP, where one deployment serves many
 * callers and the environment is the operator's. The BYOK key tools read a
 * named env var rather than taking a key as an argument, so they are only
 * registered when that env is actually the caller's — see
 * `tools/identity.ts`.
 */
export interface ServerOptions {
  readsLocalEnvironment: boolean;
}

export function buildServer(backend: BrainBackend, opts: ServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerMemoryTools(server, backend);
  registerCognitiveTools(server, backend);
  registerGraphTools(server, backend);
  registerEntitiesTools(server, backend);
  registerKnowledgeTools(server, backend);
  registerSchemaTools(server, backend);
  registerQueryTools(server, backend);
  registerWorkspaceTools(server, backend);
  registerIdentityTools(server, backend, opts.readsLocalEnvironment);

  return server;
}
