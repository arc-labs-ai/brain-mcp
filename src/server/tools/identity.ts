/**
 * Who a request runs as, what the deployment supports, and whether a provider key is installed.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";

export function registerIdentityTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Report the identity this connection runs as — the namespace and space " +
        "your API key resolves to on the server. Call it first when anything " +
        "looks like it is reading the wrong workspace.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.whoami());
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
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.capabilities());
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
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.getLlmCredential());
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "verify_llm_credential",
    {
      title: "Verify LLM credential",
      description:
        "Re-check the provider key this workspace already has, by asking the " +
        "provider. Takes nothing and sends no secret anywhere. A key that " +
        "worked when it was registered can be revoked later, and without this " +
        "the first sign is an opaque upstream failure on a write — so run it " +
        "when extraction or reasoning starts failing for no visible reason.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.verifyLlmCredential());
      } catch (err) {
        return fail(err);
      }
    },
  );
}
