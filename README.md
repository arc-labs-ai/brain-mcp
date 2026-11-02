# brain-mcp

A **managed MCP server** for the [Brain](https://github.com/arc-labs-ai) memory
database. It exposes Brain's tenant surface as MCP tools over **remote
Streamable HTTP**, so any MCP client (Claude, ChatGPT, Cursor, Copilot, …) can
give its agent durable, current-truth memory in one connection.

It is a thin, stateless front for Brain's REST surface (`/v1/*`): point it at the
hosted **gateway** or a self-hosted **brain-edge** — the JSON contract is the
same.

**It holds no credential of its own.** Each request carries the caller's own
Brain API key, which the backend resolves to that caller's namespace and space.
So one hosted deployment serves every user at their own identity, and the
isolation between them is the backend's existing per-key scoping rather than
anything this server decides. See [Identity](#identity).

## Quick start

```bash
npm install -g @brain-db/mcp
```

### Connect a client

brain-mcp speaks MCP two ways. Pick the one your client uses.

**stdio** — the client starts and owns the process. This is the usual local
setup for Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "@brain-db/mcp", "--stdio"],
      "env": {
        "BRAIN_MCP_BACKEND_URL": "https://api.arc-labs.ai",
        "BRAIN_MCP_API_KEY": "brain_…"
      }
    }
  }
}
```

**Remote HTTP** — one deployment, many users. Each client sends its own key:

```bash
brain-mcp            # listens on :3333, MCP endpoint at POST /mcp
```

```bash
claude mcp add --transport http brain https://mcp.example.com/mcp \
  --header "Authorization: Bearer brain_…"
```

```json
{
  "mcpServers": {
    "brain": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer brain_…" }
    }
  }
}
```

A request without a bearer is refused with `401`. The server has no credential
to fall back to, which is what makes it safe to expose directly rather than
behind a shared-secret gate — there is no ambient authority to reach.

`--stdio` (or `BRAIN_MCP_STDIO=1`) selects stdio; otherwise an HTTP listener
starts. On stdio the client holds the credential in its own config and the
server writes only protocol frames to stdout — all logs go to stderr, which
clients show as server logs.

The rule, in one line: **the credential comes from the transport.** On stdio
the client owns the process, so the key comes from `BRAIN_MCP_API_KEY`. Over
HTTP every request brings its own, and the environment is not consulted at all.

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
| `BRAIN_MCP_BACKEND_URL` | yes | — | Brain REST base URL (gateway or brain-edge). |
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
  -e BRAIN_MCP_BACKEND_URL=https://api.arc-labs.ai \
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

49 tools over the tenant surface. `?` marks an optional argument. No tool takes
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
| `list_extractors` | — | What will read a new memory and what it is allowed to produce. Read-only: extraction is always on. |
| `drop_schema_type` | `kind`, `name`, `force?` | Remove one declared `predicate` or `relation_type` — the only two droppable kinds. `force` is not a confirmation flag: it consents specifically to orphaning live rows. |

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

**Identity** — What this request runs as, and what the deployment can do.

| Tool | Args | What it does |
|---|---|---|
| `whoami` | — | Report the identity this connection runs as — the namespace and space your API key resolves to on the server. Call it first when anything looks like it is reading the wrong workspace. |
| `capabilities` | — | What this deployment supports — limits, enabled extractor tiers, protocol version. Use to check a limit before hitting it. |
| `llm_credential_status` | — | Whether this workspace has an LLM provider key, and which provider and model it is for. Returns a display fingerprint, never the key. Use to confirm the cause when a write is refused for a missing key. |
| `verify_llm_credential` | — | Re-check the stored key by asking the provider. Takes nothing and sends no secret. A key that worked at registration can be revoked later, and without this the first sign is an opaque upstream failure on a write. |
### Deliberately not exposed

Five tenant routes have no tool. The line is not "is it a write" — entity
merges, statement supersessions and schema drops are all writes and all tools,
because each is recoverable, scoped to one record, or both. What stays out is
what a confused or steered agent could use to leak a secret or lose something
unrecoverably:

- `PUT` / `DELETE /v1/llm-credential`, and `POST /v1/llm-credential/test` —
  all three put a **raw provider key in a request body**, which in a tool call
  means a transcript and a log. Deleting one stops every write in the
  workspace. `llm_credential_status` and `verify_llm_credential` cover the read
  side without carrying a secret. Keys are managed in the dashboard.
- `PUT /v1/schema` — destructive whole-document replacement. `upload_schema`
  merges, so the worst an agent can do is additive; `drop_schema_type` removes
  one named declaration and says what `force` actually consents to.
- `POST` / `DELETE /v1/spaces` — no space verb takes a path parameter, because
  all three act on the caller's **own** space. A delete is not "remove a space"
  but "erase this workspace", from one tool call, with no id to get wrong.
- `POST /v1/memories/vector` — takes a caller-computed embedding. An agent has
  none to supply.
- `GET /v1/subscribe` — Server-Sent Events. MCP tools are request/response, and
  no tool shape here would describe what it actually does.

None of these is reachable from `BrainBackend` either: a method with no caller
is a destructive surface with no purpose, and three of them used to sit there.

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
BRAIN_MCP_BACKEND_URL=https://api.arc-labs.ai brain-mcp
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
labelled lines:

```
error: namespace acme has no LLM credential registered
code: llm_credential.missing http 409
retry: no — this call will fail identically until the cause below is fixed
fix: this workspace has no LLM provider key configured. Brain extracts typed
     facts … a workspace admin needs to add an OpenAI or Anthropic key in the
     Arc Labs dashboard under Settings → Providers.
```

The `retry:` line is the part that changes agent behaviour. Left to infer it, an
agent either retries a terminal failure until it gives up and tells the user
their data was lost, or abandons a transient one that would have succeeded a
second later. The two conditions that are easiest to confuse are kept
distinct on purpose: `llm_credential.missing` (409, terminal, needs an admin)
and `llm_credential.unavailable` (503, transient, needs nothing).

All twelve codes `brain-edge` can emit have their own guidance; a code it grows
later renders as `(unrecognised)` with a status-derived verdict rather than
being passed through silently. The mapping and its drift guard live in
`src/server/result.ts` and `test/server/errors.test.ts`.

## License

Apache-2.0.
