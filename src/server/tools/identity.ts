/**
 * Who a request runs as, what the deployment supports, and whether a provider key is installed.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { customerId, fail, ok } from "../result.js";

export function registerIdentityTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Report the effective identity (namespace + customer scope) a request " +
        "runs as. Useful to confirm the server is scoped to the intended customer.",
      inputSchema: {
        customer_id: customerId,
      },
    },
    async ({ customer_id }) => {
      try {
        return ok(await backend.whoami(customer_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "capabilities",
    {
      title: "Capabilities",
      description:
        "What this deployment supports — limits, enabled extractor tiers, " +
        "protocol version. Use to check a limit before hitting it.",
      inputSchema: { customer_id: customerId },
    },
    async ({ customer_id }) => {
      try {
        return ok(await backend.capabilities(customer_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "llm_credential_status",
    {
      title: "LLM provider key status",
      description:
        "Whether this workspace has an LLM provider key, and which provider and " +
        "model it is for. Returns a display fingerprint, never the key. Use to " +
        "confirm the cause when a write is refused for a missing key.",
      inputSchema: { customer_id: customerId },
    },
    async ({ customer_id }) => {
      try {
        return ok(await backend.getLlmCredential(customer_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
