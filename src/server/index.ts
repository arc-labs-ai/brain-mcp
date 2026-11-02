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
 * FIVE TENANT ROUTES HAVE NO TOOL, and the backend does not implement them
 * either — a method reachable from nothing is a destructive surface with no
 * caller, which is what the previous three were:
 *
 *   - `PUT`/`DELETE /v1/llm-credential` — writing a provider key puts a secret
 *     in a tool call, where it lands in transcripts and logs; revoking one
 *     stops every write in the workspace. `POST /v1/llm-credential/test` is
 *     out for the same reason as PUT: it takes a RAW key in its body.
 *     `verify_llm_credential` re-probes the key already stored and carries
 *     nothing, so it is a tool.
 *   - `PUT /v1/schema` — replacement with `force_drop_existing` discards
 *     declarations and the rows bound to them. `upload_schema` merges, so the
 *     worst an agent can do is additive; `drop_schema_type` removes exactly
 *     one declaration and says what `force` actually consents to.
 *   - `POST`/`DELETE /v1/spaces` — none of the space verbs takes a path
 *     parameter, because all three act on the caller's OWN space. A delete is
 *     "erase this workspace", from one tool call, with no id to get wrong.
 *   - `POST /v1/memories/vector` — takes a caller-computed embedding. An agent
 *     has none to supply.
 *   - `GET /v1/subscribe` — Server-Sent Events. MCP tools are request/response;
 *     there is no shape here that would not misdescribe what the tool does.
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
const SERVER_VERSION = "0.2.0"; // x-release-please-version

/**
 * Build a fresh {@link McpServer} wired to `backend`. In stateless HTTP mode a
 * new server is built per request, so this is called on each POST.
 *
 * Registration order is the order an agent sees the tools listed, so the core
 * loop comes first and the introspection surface last.
 */
export function buildServer(backend: BrainBackend): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerMemoryTools(server, backend);
  registerCognitiveTools(server, backend);
  registerGraphTools(server, backend);
  registerEntitiesTools(server, backend);
  registerKnowledgeTools(server, backend);
  registerSchemaTools(server, backend);
  registerQueryTools(server, backend);
  registerWorkspaceTools(server, backend);
  registerIdentityTools(server, backend);

  return server;
}
