# brain-mcp

A **managed MCP server** for the [Brain](https://github.com/arc-labs-ai) memory
database. It exposes Brain's tenant surface as MCP tools over **remote
Streamable HTTP**, so any MCP client (Claude, ChatGPT, Cursor, Copilot, …) can
give its agent durable, current-truth memory in one connection.

It is a thin, stateless front for Brain's REST surface (`/v1/*`): point
`BRAIN_MCP_BACKEND_URL` at the hosted **gateway** or a self-hosted
**brain-edge** — the JSON contract is the same. It defaults to
`https://api.stg.arc-labs.ai`, the Brain that is publicly reachable today, so
a first run needs a key and nothing else.

**It holds no credential of its own.** Each request carries the caller's own
Brain API key, which the backend resolves to that caller's namespace and space.
So one hosted deployment serves every user at their own identity, and the
isolation between them is the backend's existing per-key scoping rather than
anything this server decides. See [Identity](#identity).

## Quick start

**Do not install this package directly.** It is the server; the thing that sets
a machine up is `@brain-db/cli`:

```bash
npx @brain-db/cli
```

That opens your browser, asks you to confirm a code shown in your terminal, and
configures every MCP client it finds — including this server, the Claude Code
plugin, and the skills that tell an agent when memory is worth writing. No key
is copied by hand.

```
  brain connect
  Give the agents on this machine a memory they keep between sessions.

  backend    https://api.stg.arc-labs.ai
  machine    your-laptop
  clients    Claude Code, Codex CLI, Claude Desktop

  ┌──────────────────────────────────────────┐
  │   Confirm this code in your browser      │
  │                                          │
  │                WXYZ-2345                 │
  │                                          │
  └──────────────────────────────────────────┘

  configured
    ✓ Claude Code       plugin brain installed, key in your keychain
    ✓ Codex CLI         via `codex mcp add`
    ✓ Claude Desktop    …/claude_desktop_config.json
    ✓ skill: brain-memory  ~/.agents/skills/brain-memory
```

### Why this package has no installer any more

It had one — `brain-mcp init` — and it is gone rather than deprecated, because
setting a machine up and serving an agent are different jobs:

- the installer is **one-shot and interactive**: it opens a browser, waits on a
  human, shells out to other CLIs, and can change freely because every run is
  somebody's first;
- this is **long-lived and on the hot path**: an agent starts it on every cold
  start, and it should do nothing but speak the protocol.

Fusing them also made this package the wrong thing to recommend. Nobody wants
an MCP server — they want their agent to remember things — and a tool surface
with no skill beside it is a tool surface an agent picks wrongly from. The CLI
ships both. This ships the server.

## Configuring it by hand

If you would rather not run an installer, this is what it writes:

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "@brain-db/mcp", "--stdio"],
      "env": {
        "BRAIN_MCP_BACKEND_URL": "https://api.stg.arc-labs.ai",
        "BRAIN_MCP_API_KEY": "brain_…"
      }
    }
  }
}
```

Get the key from the dashboard under **API Keys**.

## Run from source

```bash
npm install
cp .env.example .env      # set BRAIN_MCP_BACKEND_URL (and _API_KEY for stdio)
npm run build
npm start                 # HTTP on :3333, MCP endpoint at POST /mcp
npm start -- --stdio      # or stdio, for a client that owns the process
```

Liveness: `curl -fsS localhost:3333/healthz`.

### Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `BRAIN_MCP_BACKEND_URL` | no | `https://api.stg.arc-labs.ai` | Brain REST base URL (gateway or brain-edge). |
| `BRAIN_MCP_API_KEY` | stdio only | — | The caller's Brain key. Required with `--stdio`; **ignored** over HTTP, where each request carries its own. |
| `BRAIN_MCP_STDIO` | no | `false` | Serve MCP over stdin/stdout instead of HTTP (same as `--stdio`). The port/host settings are unused in that mode. |
| `BRAIN_MCP_PORT` | no | `3333` | Listen port (HTTP only). |
| `BRAIN_MCP_HOST` | no | `0.0.0.0` | Bind interface. |
| `BRAIN_MCP_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request backend timeout. |

## Container

Published to GHCR on every version tag, multi-arch (`linux/amd64`,
`linux/arm64`):

```bash
docker run -p 3333:3333 \
  -e BRAIN_MCP_BACKEND_URL=https://brain-edge.internal \
  ghcr.io/arc-labs-ai/brain-mcp:latest
```

That is the whole configuration. The image holds no credential and has no
default for one — each caller's `Authorization: Bearer brain_…` is what the
request runs as, so the same container serves every user at their own
identity. Pin a digest rather than a tag in a deploy manifest; each release
prints one.

Two things the image commits to, because a deploy depends on them:

- **`curl` is installed.** Our ECS task definition hardcodes its container
  health check as `curl -f`, so an image without it fails every probe and is
  killed and replaced in a loop that reads as the app being broken. The
  image's own `HEALTHCHECK` uses curl for the same reason — if it went
  missing, the image would fail at build time rather than in a deploy.
- **The health path is `/healthz`**, and it is unauthenticated: a load
  balancer has no bearer to send. A target group pointed at anything else
  will never see a healthy target.

The published image is smoke-tested before its manifest is tagged — it must
come up healthy, refuse an unauthenticated `POST /mcp` with a `401` and a
`WWW-Authenticate` challenge, accept a credentialed one, carry no baked-in
key, and run as a non-root user.

## Tools

58 tools over the tenant surface. `?` marks an optional argument. No tool takes
a customer or tenant id: the identity is the caller's credential, resolved
server-side, so there is nothing for an agent to set — or to get wrong.

Predicates and relation types are always `namespace:name` — `acme:prefers`,
never `prefers`. A bare name is rejected. `whoami` gives you the namespace.

**Memory** — The core loop. Most agents only ever call the first three.

| Tool | Args | What it does |
|---|---|---|
| `remember` | `content` | Store a fact, event, or conversation turn. Brain extracts typed facts and supersedes stale ones automatically. Returns the memory id. |
| `recall` | `query`, `max_results?` | Retrieve the current, consistent truth against a query. Returns an answer shape (single / many / none) with evidence and confidence — stale and contradicted facts are already resolved server-side. |
| `forget` | `memory_id`, `hard?` | Delete a specific memory. Soft by default (tombstone with a grace window); set hard=true to zero it immediately. Cascades to dependent facts. |
| `list_memories` | `limit?`, `cursor?` | Page through what is stored, newest first. Use when you need to see what exists rather than answer a question — recall is for questions, this is for inventory. |
| `inspect_memory` | `memory_id` | Everything behind one memory: the typed facts extracted from it, its provenance, and how it scored. Use when an answer looks wrong and you need to see why that memory was or was not used. |
| `materialize_directives` | `top_k?`, `min_confidence?`, `categories?` | Render this workspace's learned standing instructions into a system-prompt block, with the statement ids behind each line. Call it once at the start of a session rather than recalling directives one at a time. |
| `encode_vector` | `text`, `vector`, `model_fingerprint`, `session?`, `kind?`, `salience_hint?`, `deduplicate?` | Store a memory whose embedding you already computed. **Almost certainly not what you want** — `remember` embeds with the model the workspace was indexed under. This is for a program driving the server: a bulk import, or a migration off another store. A vector from a different embedder is refused rather than stored as noise. |

**Reasoning** — Ask Brain to plan or answer over what it knows.

| Tool | Args | What it does |
|---|---|---|
| `plan` | `start`, `goal`, `max_steps?` | Find a route from a start state to a goal across what is known. Use for 'how do we get from here to there' questions; it reasons over stored facts rather than inventing steps. |
| `reason` | `observation` | Infer what follows from an observation, given what is already known. Use to check an implication before acting on it. |

**Entities** — The typed entity layer. `entity_type_id` comes from `get_schema`.

| Tool | Args | What it does |
|---|---|---|
| `create_entity` | `entity_type_id`, `canonical_name` | Declare an entity of a known type. Creating one that already exists under the same name is a conflict, not a silent no-op — resolve_entity first if you are unsure. |
| `list_entities` | `entity_type_id`, `limit?`, `cursor?` | Entities of one type. The type is required — listing across every type is refused rather than silently paged. |
| `resolve_entity` | `candidate_name` | Map a surface form ('the Acme account', 'Priya') to the entity it refers to, or report no match. Use before creating, and before assuming two mentions are the same thing. |
| `get_entity` | `entity_id` | One entity by id, with its canonical name, type and attributes. |
| `traverse_entity` | `entity_id`, `depth?`, `limit?` | Walk outward from an entity along its relations. Use to answer 'what is connected to this, and how' without pulling the whole graph. |
| `entity_relations` | `entity_id`, `limit?`, `cursor?` | The relations attached to one entity, without walking further out. |
| `update_entity` | `entity_id`, `canonical_name`, `aliases?`, `attributes?` | Replace an entity's fields **wholesale** — omitting `aliases` clears them. Read with `get_entity` first. For a name change prefer `rename_entity`. |
| `rename_entity` | `entity_id`, `new_canonical_name`, `move_to_alias?` | Give an entity a new canonical name, keeping the old one as an alias by default — that alias is how a mention in older text still resolves. |
| `merge_entities` | `survivor_entity_id`, `merged_entity_id`, `confidence?`, `reason?` | Fold a duplicate into the entity that remains. The direction is not symmetric; `unmerge_entity` is the way back. |
| `unmerge_entity` | `entity_id` | Pull an entity back out of the survivor it was merged into. Pass the absorbed id, not the survivor's. |
| `delete_entity` | `entity_id`, `reason?` | Tombstone an entity. If it is a duplicate rather than a mistake, `merge_entities` keeps its mentions instead of stranding them. |

**Graph** — Typed relations between entities.

| Tool | Args | What it does |
|---|---|---|
| `link` | `source`, `target`, `kind` | Connect two memories with a typed edge (caused, followed_by, derived_from, similar_to, contradicts, supports, references, part_of). Use when the relationship is real but neither memory states it. |
| `unlink` | `source`, `target`, `kind` | Remove a typed edge between two memories. Idempotent. |
| `graph` | `limit?`, `cursor?` | A page of the workspace's knowledge graph — entities and the relations between them. Use to see structure; use recall to answer a question. |

**Knowledge** — Read the statements and relations Brain extracted.

| Tool | Args | What it does |
|---|---|---|
| `list_statements` | `limit?`, `cursor?` | Page through the subject–predicate–object facts extracted from this workspace's memories. Use to audit what Brain believes, not to answer a question. |
| `get_statement` | `statement_id` | One statement by id, with the memory it came from. |
| `get_relation` | `relation_id` | One relation by id, with its endpoints and type. |
| `statement_history` | `statement_id` | The full supersession chain, oldest to newest. Reach for it when a recall and a statement disagree: recall ranks by similarity, so a superseded claim can outrank the one that replaced it. |
| `create_statement` | `kind`, `subject`, `predicate`, `object`, `confidence?`, `event_at_unix_nanos?`, `valid_from_unix_nanos?`, `valid_to_unix_nanos?`, `session_id?`, `evidence?` | Assert a claim directly instead of waiting for extraction. `event_at` is when it HAPPENED; `valid_from`/`valid_to` are when the claim is held true. |
| `supersede_statement` | `statement_id` + every `create_statement` field | Replace a claim with a corrected one, keeping both and the link between them. The right tool when something changed — not `delete_statement`, which loses the history of having believed it. |
| `delete_statement` | `statement_id`, `reason?`, `message?` | Soft-tombstone a claim; the row survives for audit. |
| `retract_statement` | `statement_id`, `reason?`, `message?` | Retract a claim so its **content** does not survive. Prefer `delete_statement` unless the content itself is the problem. |
| `create_relation` | `relation_type`, `from_entity`, `to_entity`, `confidence?`, `valid_from_unix_nanos?`, `valid_to_unix_nanos?`, `session_id?`, `evidence?`, `properties?` | Assert a typed edge between two entities. For an untyped edge between two **memories**, use `link`. |
| `supersede_relation` | `relation_id` + every `create_relation` field | Replace an edge with a corrected one, keeping the chain. `properties` is replaced, not merged. |
| `delete_relation` | `relation_id`, `reason?` | Tombstone a typed edge. Traversals stop crossing it. |

**Schema** — Declare the entity and relation types this namespace uses.

| Tool | Args | What it does |
|---|---|---|
| `get_schema` | — | The entity and relation types declared for this workspace. Read this before creating entities — `entity_type_id` comes from here. |
| `validate_schema` | `schema_document` | Check a schema document without storing it. Use before upload_schema so a malformed document is caught before it changes anything. |
| `upload_schema` | `schema_document` | Merge new declarations into the workspace schema. Additive: it cannot drop a declaration, and changing an existing one is a conflict. Replacing a schema destructively is not available here. |
| `list_schema_versions` | `limit?`, `cursor?` | The schema's version history, as opposed to `get_schema`'s one current document. Use to see when a declaration appeared. |
| `list_entity_types` | — | The entity types this workspace can use, each with the numeric `entity_type_id` that `create_entity` and `list_entities` require. Read it when you have a `namespace:Name` and need the id. |
| `list_extractors` | — | What will read a new memory and what it is allowed to produce. Read-only: extraction is always on. |
| `drop_schema_type` | `kind`, `name`, `force?`, `scope?` | Remove one declared `predicate` or `relation_type` — the only two droppable kinds. `force` is not a confirmation flag: it consents specifically to orphaning live rows. |
| `replace_schema` | `schema_document`, `force_drop_existing`, `scope?` | Replace the whole document instead of merging. Anything the new document omits is a removal, and the rows bound to a dropped declaration go with it. `force_drop_existing` is required with no default; run it `false` first to see what would go. |

**Query** — What Brain would do, and what it did.

| Tool | Args | What it does |
|---|---|---|
| `explain_query` | `text` | The plan for a query and its estimated cost, **without running it**. Use when a recall was slow or empty and you want to know why before retrying. |
| `trace_query` | `text` | Runs the query and reports what each stage actually cost. Note that it RUNS — it is not the free counterpart to `explain_query`. |

**Workspace** — Sessions and spaces.

| Tool | Args | What it does |
|---|---|---|
| `create_session` | `session_id`, `title?` | Provision a session so one conversation's memories can be told from another's. The id is yours to choose and the call is idempotent on it. |
| `list_sessions` | `limit?` | The sessions in this workspace. |
| `delete_session` | `session_id`, `hard?` | Retire a session. Soft by default, which leaves its memories in place. |
| `list_spaces` | `limit?` | The spaces this credential can see. `whoami` says which one you write to. |
| `create_space` | `metadata?` | Provision **this caller's** space and report its stats. Takes no name and creates no other space — which space you are in is decided by the key you connect with. Idempotent: `created: false` means it already existed. A space is an isolation boundary, unlike a session. |
| `delete_space` | `confirm_space_id` | Erase **this caller's** whole workspace — every memory, and the typed graph derived from it. No soft mode and nothing restores it. `confirm_space_id` is required and must equal the `space_id` `whoami` reports; a value that does not match is refused and deletes nothing. |
| `subscribe_events` | `from_lsn?`, `include_history?`, `max_events?`, `wait_ms?`, `sessions?`, `memories?` | Read what changed since a point in the feed. Returns a **bounded slice and closes** — it does not stream. Pass the returned `last_lsn` back as `from_lsn` to continue without gaps. An empty result means nothing happened in the window. |

**Identity** — What this request runs as, and what the deployment can do.

| Tool | Args | What it does |
|---|---|---|
| `whoami` | — | Report the identity this connection runs as — the namespace and space your API key resolves to on the server. Call it first when anything looks like it is reading the wrong workspace. |
| `capabilities` | — | What this deployment supports — limits, enabled extractor tiers, protocol version. Use to check a limit before hitting it. |
| `llm_credential_status` | — | Whether this workspace has an LLM provider key, and which provider and model it is for. Returns a display fingerprint, never the key. Use to confirm the cause when a write is refused for a missing key. |
| `verify_llm_credential` | — | Re-check the stored key by asking the provider. Takes nothing and sends no secret. A key that worked at registration can be revoked later, and without this the first sign is an opaque upstream failure on a write. |
| `put_llm_credential` | `provider`, `model`, `api_key_env` | Install this workspace's provider key, so writes can be extracted. Takes the **name of an environment variable**, never a key — the handler reads it, so the secret never enters a tool argument. Verified with the provider before it is stored. **stdio only.** |
| `test_llm_credential` | `provider`, `model`, `api_key_env` | Probe a key against the provider without storing it or touching the registered one. Same env-var rule as above. **stdio only.** |
| `delete_llm_credential` | — | Revoke the provider key. **Every subsequent write is refused** until one is registered again. Incident response, not cleanup. **stdio only.** |
### How the hazardous routes are shaped

The line is not "is it a write" — entity merges, statement supersessions and
schema drops are all writes and all tools, because each is recoverable, scoped
to one record, or both. What matters is whether a confused or steered agent
could leak a secret or lose something unrecoverably. Five routes that once had
no tool now have one, because each found a shape that keeps its hazard out of
reach:

- **`PUT` / `POST /v1/llm-credential[/test]`** take a raw provider key. The
  tools take the **name of an environment variable** instead and read it in the
  handler, so the key never occupies a tool argument — where it would be
  written into the model's context and into every transcript and log of the
  session, and stay valid there. They are registered **on stdio only**: over
  HTTP the process environment belongs to whoever runs the deployment, not to
  the caller, so the same argument would read someone else's secret.
  `DELETE` carries no secret and is a plain tool, marked destructive because
  revoking stops every write.
- **`PUT /v1/schema`** replaces rather than merges, and `force_drop_existing`
  takes the rows bound to a dropped declaration with it. The flag is
  **required with no default**, so the destructive choice cannot be made by
  omission, and running it `false` first reports what would go.
- **`POST /v1/memories/vector`** takes a caller-computed embedding, which an
  agent cannot produce. The tool exists for a program driving this server; its
  description sends an agent to `remember`.
- **`GET /v1/subscribe`** is Server-Sent Events, which request/response cannot
  represent. `subscribe_events` drains a **bounded** slice — to a deadline and
  an event count — and returns the resume LSN, so following the feed is a loop
  the caller drives rather than a tool that hangs.
- **`DELETE /v1/spaces`** takes no path parameter, because every space verb
  acts on the caller's *own* space — so it is "erase this workspace" from a
  single call, with no id in the request that could fail to match and nothing
  that undoes it. `delete_space` supplies the missing id: `confirm_space_id`
  is **required with no default** and is checked against the space the
  credential actually resolves to, so a caller that is in a different
  workspace than it believes gets a refusal and loses nothing. Read the id
  from `whoami` immediately before the call. It is the only tool that reads
  before it writes, and the extra `whoami` is the price of that check.

**Every route on the tenant surface now has a tool.**

## Identity

Every request runs as the caller, and nothing about that is this server's
decision.

The caller's `brain_…` API key goes to the backend verbatim as
`Authorization: Bearer`. The backend resolves it to the `(namespace, space)`
the key is bound to and runs the operation as that tenant — the same path the
SDK and plain `curl` take. Rate limiting, metering and billing key off the same
resolved scope, so a hosted deployment accounts per user without being told who
anyone is.

This is why there is no `customer_id` argument, and why adding one back would
be worse than useless. Both backends scope by the key alone:

- **Hosted gateway** — reads the `x-brain-namespace` / `x-brain-space` headers
  only for console JWTs, and **ignores them for API keys**
  (`services/gateway/src/api/middleware/auth.rs`). A key's own bound scope wins.
- **Self-hosted brain-edge** — scopes by the key's bound identity and ignores
  the scope headers too.

So a tool argument that claimed to select a customer would be accepted, sent,
ignored, and reported as success. Earlier versions of this server did exactly
that, and the server also held one shared service key — which meant every
caller of a hosted deployment landed in that key's workspace while the surface
read as if it isolated them. Per-caller credentials are what makes the one-URL
deployment correct; dropping `customer_id` is what stops it claiming to be
correct in a second, contradictory way.

To check which identity a connection has, call `whoami`. It reports what the
backend resolved, not what this server was configured with, so it cannot agree
with a mistake.

### Running one

Public, no shared secret, no network boundary required:

```bash
BRAIN_MCP_BACKEND_URL=https://brain-edge.internal brain-mcp
```

A request with no bearer gets a `401` and reaches the backend not at all. There
is deliberately no env-var fallback on the HTTP path: a server-held key would
make a client that forgot its header succeed as somebody — the one failure mode
that is invisible in production, because it looks exactly like working.

### No OAuth today

`BRAIN_MCP_OAUTH_ENABLED` is gone, and setting it is a startup failure rather
than a no-op.

OAuth and pass-through are not two settings; they are two answers to "what is
in the `Authorization` header", and there is one header. The OAuth mode put a
JWT there, called the backend with a server-held service key, and selected a
namespace from a token claim — a claim both backends ignore for key callers. It
authenticated the caller and then served them the service key's workspace. A
deployment that set the flag believed it was isolating tenants, so the flag
fails loudly instead of quietly.

Real OAuth needs an authorization server that signs asymmetrically and
publishes JWKS, and a way to map a verified token to a Brain identity. Neither
exists yet. When they do, this is where it goes.

## Errors

Every tool funnels failures through one renderer, so a condition reads the same
whichever tool hit it. A failed call comes back as an `isError` result (never a
thrown exception, which an MCP client reports as a transport fault) with four
labelled lines, plus a fifth when the backend supplied a trace id:

```
error: namespace acme has no LLM credential registered
code: llm_credential.missing http 409
retry: no — this call will fail identically until the cause below is fixed
fix: this workspace has no LLM provider key configured. Brain extracts typed
     facts … a workspace admin needs to add an OpenAI or Anthropic key in the
     Arc Labs dashboard under Settings → Providers.
trace_id: 01a1a1f6-0134-7ae1-8525-aaa6952f8d9d
```

The `trace_id` line appears only when the backend sent one — the gateway does
on every problem response, and it is the difference between "something broke"
and a line an operator can search, because the gateway withholds 5xx detail
from the response on purpose and logs it under that id.

The `retry:` line is the part that changes agent behaviour. Left to infer it, an
agent either retries a terminal failure until it gives up and tells the user
their data was lost, or abandons a transient one that would have succeeded a
second later. The two conditions that are easiest to confuse are kept
distinct on purpose: `llm_credential.missing` (409, terminal, needs an admin)
and `llm_credential.unavailable` (503, transient, needs nothing).

All twenty-six codes **either backend** can emit have their own guidance, and
that span matters: the gateway and brain-edge barely overlap — `unauthorized`
and `bad_request` against `auth.invalid_key` and `request.malformed` — so a
table built from one leaves the other almost entirely unrecognised. A code
either backend grows later renders as `(unrecognised)` with a status-derived
verdict rather than being passed through silently. The mapping and its drift
guard live in `src/server/result.ts` and `test/server/errors.test.ts`.

## License

Apache-2.0.
