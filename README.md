# git forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rangerkit/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rangerkit/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge as one standalone Node process: git smart HTTP
(protocol v2 ls-refs/fetch with a v0 fallback, fast-forward-only pushes with
report-status), the REST v3 API (repositories, branches, commits, contents,
labels, issues, comments, pull requests and merges), the GraphQL v4 documents
`gh` sends, and an MCP endpoint whose six tools act on the same store — all
over one shared in-memory state, with no dependencies beyond the Node standard
library and no git binary.

## Running

The process is the entry for the make.fun `github-core-clone-01` bounty:

```sh
MAKEFUN_ENV_URL=http://env:8080 MAKEFUN_SHOP_TOKEN=shpat_... node main.ts
```

It binds an ephemeral port, registers it with the env, serves until the env
says the trial is done, and exits 0. Server-side commits take their timestamps
from a deterministic counter, so replaying the same request sequence produces
the same object ids.

## Layout

- `main.ts` — the env lifecycle (register, poll `/done`, exit).
- `app.ts` — the HTTP server and routing.
- `lib/gitcore.ts` — the git object model: SHA-1 ids, commits/trees/tags,
  packfile read/write with delta resolution, pkt-line framing.
- `lib/store.ts` — the shared in-memory forge: repositories, refs, objects,
  issues, pull requests, three-way merges.
- `lib/githttp.ts` — advertisements, ls-refs, fetch and receive-pack.
- `lib/rest.ts` — the REST v3 surface.
- `lib/graphql.ts` — the GraphQL v4 surface.
- `lib/mcp.ts` — the MCP endpoint (discovery and legacy handshake, six tools).
