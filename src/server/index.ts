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
 * THREE OPERATIONS ARE DELIBERATELY NOT TOOLS, though the backend implements
 * them:
 *
 *   - `PUT /v1/llm-credential` — writes a provider key. A tool that accepts
 *     secrets is a prompt-injection target, and an agent has no business
 *     holding one.
 *   - `DELETE /v1/llm-credential` — revoking the key stops every write in the
 *     workspace.
 *   - `PUT /v1/schema` with `force_drop_existing` — discards declarations and
 *     the rows bound to them.
 *
 * Each is reachable from `BrainBackend` for an operator-facing caller. The
 * line is "can a confused or steered agent cause irreversible loss or leak a
 * secret", not "is it a write".
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrainBackend } from "../backend/index.js";
import { registerCognitiveTools } from "./tools/cognitive.js";
import { registerEntitiesTools } from "./tools/entities.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerSchemaTools } from "./tools/schema.js";

const SERVER_NAME = "brain-mcp";
// Reported to the client as `serverInfo.version` on initialize, so it has to
// track package.json. It is hand-written rather than imported because the
// published layout puts package.json outside dist/; release-please stamps it
// via the annotation, which is why this file is in `extra-files`. It had
// already drifted once -- 0.1.1 shipped reporting 0.1.0.
const SERVER_VERSION = "0.2.1"; // x-release-please-version

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
  registerIdentityTools(server, backend);

  return server;
}
