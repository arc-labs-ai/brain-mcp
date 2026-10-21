# Changelog

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
