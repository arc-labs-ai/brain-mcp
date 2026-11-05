---
name: brain-memory
description: Use when the session involves durable memory across conversations — storing what the user told you (preferences, decisions, project facts), recalling what was said before, correcting something that changed, or building a typed entity graph. Triggers on "remember", "recall", "forget", "what do you know about me", "we decided", "from now on", and whenever a fact learned in this session would be useful in the next one.
---

# Brain memory

Brain is a memory database reached through the `brain` MCP server. It is not a
note file: it extracts typed facts from what you store, supersedes the ones
that changed, and returns what is **currently true** rather than everything
ever written.

## Store what will matter next time, not this time

`remember` costs a round trip and consumes the namespace. Store a thing when
it will still be true and still be useful in a conversation that has not
happened yet:

- **Worth storing**: stable preferences ("uses pnpm, not npm"), decisions and
  their reasons ("chose Postgres over Mongo because of the join load"), project
  facts that are not in the repo ("staging deploys are gated on the release
  manager"), constraints the user states ("never deploy to production").
- **Not worth storing**: anything derivable from the code or git history, the
  contents of a file you just read, the step you are on, or a fact that expires
  with this task.

Write one fact per `remember` in a self-contained sentence. "The user prefers
pnpm" survives on its own; "yes, that one" does not, because the recall that
returns it will not carry the question.

**Never store a secret.** API keys, tokens, passwords and connection strings
with credentials in them do not go into memory, even when the user pastes one
into the conversation. Memory is durable and shared across every session that
holds the key.

## Recall before you assume

When the user refers to something settled earlier — "like we agreed", "the
usual way", "my preference" — `recall` it rather than guessing or asking them
to repeat themselves. Recall takes a natural-language query and returns the
memories that currently answer it, each with a confidence.

Two things to know about what comes back:

- A recall returns the current truth, but **ranking is similarity, not
  recency**. When two memories disagree, the one that reads closer to your
  query wins, which can be the stale one. If an answer looks out of date,
  check it against what the user is saying now rather than asserting it.
- `answer_kind` tells you the shape: `single`, `many`, or `none`. `none` is a
  real answer — it means nothing is stored, not that the call failed, and the
  honest reply is that you do not know rather than an invention.

## Correcting is storing, not deleting

When something changes — they switched from npm to pnpm, the decision was
reversed — **store the new fact**. Brain supersedes the old one. Reach for
`forget` only when the memory should never have existed: it was wrong when
written, it was about the wrong person, or it holds something private that
should not persist.

## The id shapes differ, and mixing them fails quietly

- A **memory id** is a long decimal string. `inspect_memory`, `forget` and
  memory references in a statement all take that.
- **Entity, statement and relation ids** are UUIDs.

Rendering a memory id as a UUID produces something that looks right and
resolves to nothing. Pass back exactly what the tool returned.

## Beyond remember and recall

Reach for these when the simple loop is not enough:

- `plan` and `reason` — ask Brain to work over what it holds, rather than
  pulling memories back and reasoning in the transcript.
- `create_entity`, `create_statement`, `create_relation` — build a typed graph
  when the user's domain has real objects with relationships worth querying
  (people, services, repositories), not for loose prose.
- `list_memories` and `inspect_memory` — when the user asks what is stored, or
  why a recall returned something surprising.
- `whoami` — which namespace and space this key is bound to, when a recall
  comes back empty and you suspect the wrong workspace.

## When the tools are not there

If the `brain` tools are missing, the server is not connected — do not
pretend to remember. Say so, and point at the one-line fix:

```
/plugin install brain --marketplace arc-labs-ai/brain-mcp
```
