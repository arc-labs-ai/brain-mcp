/**
 * Planning and inference over what is already stored, rather than over the prompt.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";

export function registerCognitiveTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "plan",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Plan",
      description:
        "Find a route from a start state to a goal across what is known about " +
        "the workspace. Use for 'how do we get from here to there' questions; it " +
        "reasons over stored facts rather than inventing steps.",
      inputSchema: {
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
        max_branches: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("How many alternatives to explore at each step."),
        max_wall_time_ms: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Give up after this long and return the best route found so far."),
        strategy: z
          .enum(["auto", "astar", "mcts", "attractor"])
          .optional()
          .describe(
            "Search strategy. `auto` (default) lets Brain choose; the others " +
              "pin it — `astar` for a shortest path over known edges, `mcts` " +
              "when the branching is wide, `attractor` for a rollout toward " +
              "the goal region.",
          ),
        include_trace: z
          .boolean()
          .optional()
          .describe(
            "Return the bidirectional-search trace: every node visited from " +
              "each end and every meeting point, including ones a cap " +
              "dropped. For diagnosing a route you did not expect.",
          ),
      },
    },
    async ({
      start,
      goal,
      max_steps,
      max_branches,
      max_wall_time_ms,
      strategy,
      include_trace,
    }) => {
      try {
        return ok(
          await backend.plan(start, goal, {
            max_steps,
            max_branches,
            max_wall_time_ms,
            strategy,
            include_trace,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "reason",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Reason",
      description:
        "Infer what follows from an observation, given what is already known " +
        "in the workspace. Use to check an implication before acting on it.",
      inputSchema: {
        observation: z.string().min(1).describe("What was observed."),
        depth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("How many inference hops to take from the observation."),
        confidence_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Drop inferences below this confidence rather than reporting them."),
        max_inferences: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Cap on how many conclusions come back."),
        budget_wall_time_ms: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Give up after this long and return what was inferred so far."),
        include_trace: z
          .boolean()
          .optional()
          .describe(
            "Return the evidence walk: every edge considered, what pruned the " +
              "ones that were dropped, and the components behind each " +
              "confidence. For diagnosing an inference you did not expect.",
          ),
      },
    },
    async ({
      observation,
      depth,
      confidence_threshold,
      max_inferences,
      budget_wall_time_ms,
      include_trace,
    }) => {
      try {
        return ok(
          await backend.reason(observation, {
            depth,
            confidence_threshold,
            max_inferences,
            budget_wall_time_ms,
            include_trace,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
