# GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/t7007462-gif/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/t7007462-gif/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A small, dependency-free GitHub-compatible git forge written in TypeScript for
Node 22. It speaks the surfaces a git client and the GitHub API clients expect:

- **git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch`, shallow and
  deepen, sideband packfiles) and receive-pack v0 (report-status, side-band-64k,
  fast-forward checks, mixed pushes), with a from-scratch pack reader/writer
  (plain objects, OFS/REF delta resolution, sha1 trailer verification).
- **REST v3** (`/api/v3`) — repositories, branches, commits, refs, labels,
  issues, comments, pull requests (squash merge, conflict detection), and the
  contents API (create / update / delete files as commits), with GitHub-style
  pagination, `Link` headers and `X-GitHub-Request-Id` on every reply.
- **GraphQL** (`/api/graphql`) — `viewer`, `repository`, `node`, `__type`
  introspection, issue / pull-request connections with cursor pagination, and
  the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` and
  `addComment` mutations.
- **MCP** (`/mcp`) — JSON-RPC 2.0 over streamable HTTP, modern
  `server/discover` (2026-07-28) plus the legacy `initialize` handshake, with
  tools for creating repos, issues and pull requests and for merging.

Everything is in-memory: `main.ts` is the trial lifecycle (bind an ephemeral
port, register with the environment, exit when the run is done), `app.ts` is the
HTTP server, `store.ts` holds the repositories and their objects, and `git.ts`
is the git plumbing (objects, packs, pkt-lines, reachability).

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must point at the trial environment; without it the process
exits. `GET /healthz` answers without a token; every other route needs
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — entrypoint and environment lifecycle
- `app.ts` — HTTP routing, REST v3, GraphQL, MCP, git smart HTTP
- `store.ts` — in-memory repositories, issues, pull requests, serializers
- `git.ts` — git objects, packfiles, pkt-lines, reachability

Built for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) on
[make.fun](https://make.fun/?ref=7pcj4z9y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01).
