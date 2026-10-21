/**
 * Planning and inference over what is already stored, rather than over the prompt.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { customerId, fail, ok } from "../result.js";

export function registerCognitiveTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "plan",
    {
      title: "Plan",
      description:
        "Find a route from a start state to a goal across what is known about " +
        "the customer. Use for 'how do we get from here to there' questions; it " +
        "reasons over stored facts rather than inventing steps.",
      inputSchema: {
        customer_id: customerId,
        start: z.string().min(1).describe("The starting state, in plain language."),
        goal: z.string().min(1).describe("The desired end state."),
        max_steps: z
          .number()
          .int()
          .min(1)
          // Brain's planner refuses anything above its own
          // `max_traversal_depth`, which defaults to 10. The schema advertised
          // 50, so an agent reading it would pick a value in 11..50, pass
          // validation here, and be refused by the server with
          // `50 exceeds max_traversal_depth = 10`. Matching the server's
          // default keeps the schema honest; a deployment that raises the
          // limit just makes this conservative rather than wrong.
          .max(10)
          .optional()
          .describe(
            "Cap on plan length, 1-10. Brain refuses more than its " +
              "max_traversal_depth (default 10).",
          ),
      },
    },
    async ({ customer_id, start, goal, max_steps }) => {
      try {
        return ok(await backend.plan(customer_id, start, goal, max_steps));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "reason",
    {
      title: "Reason",
      description:
        "Infer what follows from an observation, given what is already known " +
        "about the customer. Use to check an implication before acting on it.",
      inputSchema: {
        customer_id: customerId,
        observation: z.string().min(1).describe("What was observed."),
      },
    },
    async ({ customer_id, observation }) => {
      try {
        return ok(await backend.reason(customer_id, observation));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
