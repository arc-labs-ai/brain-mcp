# Changelog

## [0.4.1](https://github.com/arc-labs-ai/brain-mcp/compare/v0.4.0...v0.4.1) (2026-11-13)


### Features

* **mcp:** close the tool surface, fix the bi-temporal fields, and expose delete_space ([#16](https://github.com/arc-labs-ai/brain-mcp/issues/16)) ([a1e1fc3](https://github.com/arc-labs-ai/brain-mcp/commit/a1e1fc35dffe4490d15242f6f5e83e839674e11a))

## [0.4.0](https://github.com/arc-labs-ai/brain-mcp/compare/v0.3.2...v0.4.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* `brain-mcp init` is removed, along with the bundled Claude Code plugin and its marketplace manifest. They live in @brain-db/cli and the brain-kit repo now. There is no alias and no deprecation path — the published 0.3.2 never started at all, so nothing was depending on either.

### Fixes

* **build:** keep the bin executable when dist is regenerated ([29c9d0c](https://github.com/arc-labs-ai/brain-mcp/commit/29c9d0cabc2e3f6bdbd39bd033f58161999475b8))
* **cli:** start when invoked through the bin symlink npm installs ([d395238](https://github.com/arc-labs-ai/brain-mcp/commit/d395238c3af7cb53d6a6e8553126b9c174a7491b))
* **init:** do not write a Claude Code server that shadows the plugin's ([70e0033](https://github.com/arc-labs-ai/brain-mcp/commit/70e0033dbc1abd084bc1c23f3e50846ea362375f))


### Features

* annotate every tool and disambiguate the ones that read alike ([cfdeabc](https://github.com/arc-labs-ai/brain-mcp/commit/cfdeabce53c934de3e952d0ea511820e480ab80a))
* **init:** one command to connect every MCP client on this machine ([4285c44](https://github.com/arc-labs-ai/brain-mcp/commit/4285c449cf5c6aa3c205fea37e66736ef1a70b5f))
* move setup out of the server into @brain-db/cli ([bc3cd2b](https://github.com/arc-labs-ai/brain-mcp/commit/bc3cd2bdd5a2c3246324a83ece6b776e090d0fb7))

## [0.3.2](https://github.com/arc-labs-ai/brain-mcp/compare/v0.3.1...v0.3.2) (2026-11-03)


### Fixes

* **deps:** make patched dependency versions a floor, and test the node range we claim ([#12](https://github.com/arc-labs-ai/brain-mcp/issues/12)) ([9ee5409](https://github.com/arc-labs-ai/brain-mcp/commit/9ee540996815b7ac0af70407e1a51c4e08dd42ae))

## [0.3.1](https://github.com/arc-labs-ai/brain-mcp/compare/v0.3.0...v0.3.1) (2026-11-03)


### ⚠ BREAKING CHANGES

* **deps:** move to zod 4, clearing the last production advisory

### Fixes

* **deps:** move to zod 4, clearing the last production advisory ([c893ba2](https://github.com/arc-labs-ai/brain-mcp/commit/c893ba2ea7bea126cf3e42aadaf6d8e8945c137a))
* **deps:** take the patched MCP SDK, proxy-addr and body-parser ([f6bb81a](https://github.com/arc-labs-ai/brain-mcp/commit/f6bb81a124e28229e74684781388e3875ee6f4b3))


### Tests and verification

* **contract:** verify the route of every tool, not four of forty-nine ([17c70eb](https://github.com/arc-labs-ai/brain-mcp/commit/17c70ebaa05e64010bc93ffbd06163927b6789d2))


### Build and tooling

* audit production dependencies, so a critical cannot sit unnoticed ([ecd8aaf](https://github.com/arc-labs-ai/brain-mcp/commit/ecd8aafb01fc3ba7b0c67945fff8d9427e2b1442))
* **release:** keep feat changes on the 0.3 line ([0d8dd22](https://github.com/arc-labs-ai/brain-mcp/commit/0d8dd223705758e914b8ffca9f2b8a1f58b9085f))


### Documentation

* drop a hostname that does not resolve, and correct two counts ([58deee2](https://github.com/arc-labs-ai/brain-mcp/commit/58deee25bf504045b7435700028d51b36d562c75))
* **package:** say 49 tools, not 25, and gate the count ([10c2670](https://github.com/arc-labs-ai/brain-mcp/commit/10c2670452cb48de2090abc9b255ea7f5653872f))
* show the trace_id line the error renderer actually emits ([b0b6e00](https://github.com/arc-labs-ai/brain-mcp/commit/b0b6e00699ed560f804f86d8e6c85711b053e852))


### Chores

* release 0.3.1 ([5a3e31a](https://github.com/arc-labs-ai/brain-mcp/commit/5a3e31a4ca682aa36ea14b1700df6ec8baa8b803))

## [0.3.0](https://github.com/arc-labs-ai/brain-mcp/compare/v0.2.1...v0.3.0) (2026-11-02)


### ⚠ BREAKING CHANGES

* **mcp:** tools no longer accept `customer_id`, and the HTTP transport requires an `Authorization: Bearer` header on every request. `BRAIN_MCP_OAUTH_*` and `BRAIN_MCP_NAMESPACE`/`_NAMESPACE_HEADER`/`_SCOPE_HEADER` are removed, and `BRAIN_MCP_OAUTH_ENABLED` now refuses to start.

### Features

* **mcp:** run every request as the caller, and cover the whole tenant surface ([533eadd](https://github.com/arc-labs-ai/brain-mcp/commit/533eaddbdeff27eefe613499ee2dbc0d7d39518b))


### Build and tooling

* **docker:** publish a container image to GHCR for the hosted endpoint ([c0f5774](https://github.com/arc-labs-ai/brain-mcp/commit/c0f577496ae35ac3813b04aad27e52fbb0ce8f47))

## [0.2.1](https://github.com/arc-labs-ai/brain-mcp/compare/v0.2.0...v0.2.1) (2026-10-21)


### Fixes

* **package:** drop the ./ from the bin path so npm stops rewriting it ([088eacb](https://github.com/arc-labs-ai/brain-mcp/commit/088eacb5a3150c927b1b4fbfca53d9fab535ae87))

## [0.2.0](https://github.com/arc-labs-ai/brain-mcp/compare/v0.1.1...v0.2.0) (2026-10-21)


### Features

* **transport:** serve MCP over stdio, and stop wasting the agent's context ([fdcfdd5](https://github.com/arc-labs-ai/brain-mcp/commit/fdcfdd5dd293aba9c0e8c4e8c6693e3252c5d47a))

## [0.1.1](https://github.com/arc-labs-ai/brain-mcp/compare/v0.1.0...v0.1.1) (2026-10-21)


### Fixes

* **ci:** stop linting the files release-please owns ([2814f31](https://github.com/arc-labs-ai/brain-mcp/commit/2814f3163f64a94640bd447f4982591b4ac3c22d))

## 0.1.0 (2026-10-21)


### ⚠ BREAKING CHANGES

* **mcp:** failed tool calls no longer render as a single `error: brain backend returned <status>: <body>` line. A client scraping that text must read the `code:` and `retry:` lines instead.

### Features

* brain-mcp M1 — managed MCP server over Streamable HTTP ([e77aa74](https://github.com/arc-labs-ai/brain-mcp/commit/e77aa74275014ae7eb0d9f04930e90d251e380f5))
* **mcp:** default scope header to x-brain-space ([85b3b58](https://github.com/arc-labs-ai/brain-mcp/commit/85b3b584c1360bf73ac9dd9e24cfffce293f7582))
* **mcp:** full tenant surface, modular layout, and a real error contract ([cfd0b82](https://github.com/arc-labs-ai/brain-mcp/commit/cfd0b827a158952a92b9a72d224f2ac2749f09ed))
* **mcp:** M2 — OAuth 2.1 resource server with per-tenant token routing ([6c429ec](https://github.com/arc-labs-ai/brain-mcp/commit/6c429ec76f9e697e0bc4264b017f1ae6848be57b))


### Tests and verification

* **mcp:** end-to-end /v1/* contract coverage + self-host scoping note ([d8246d0](https://github.com/arc-labs-ai/brain-mcp/commit/d8246d0b2c4bd9575bbe15cfb22a22b6868690bb))


### Build and tooling

* add CI and release wiring for npm publishing ([afab4ff](https://github.com/arc-labs-ai/brain-mcp/commit/afab4ffab5fe5aeb63d879cf7d38b315ddcb9074))


### Chores

* **release:** pin the first npm release to 0.1.0 ([5899996](https://github.com/arc-labs-ai/brain-mcp/commit/589999625eedfda283c9feb88f95795a5a498de7))
