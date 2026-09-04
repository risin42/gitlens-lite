# GitLens Architecture (local/community build)

This repository builds a local GitLens extension for VS Code. The extension keeps the
Inspect surface, inline blame, repository views, stash and patch workflows, worktrees,
rebase, and allowed-signers support. It does not contain account, hosted-service, AI,
agent, or subscription code.

## Runtime layers

```text
VS Code extension host
        |
        +-- src/commands, src/views, src/annotations, src/trackers
        |
        +-- src/container.ts (service locator and lifecycle)
        |
        +-- src/git/gitProviderService.ts
                |
                +-- GlCliGitProvider (src/env/node/git/cliGitProvider.ts)
                        |
                        +-- @gitlens/git-cli (Git process and parsers)
                                |
                                +-- @gitlens/git (models, providers, cache)
                                        |
                                        +-- @gitlens/utils
```

`src/env/` keeps host-specific behavior behind small seams. Desktop VS Code executes the
local Git CLI. The browser build has no local Git process and therefore does not register a
Git provider unless the host supplies one.

The workspace packages have deliberately small responsibilities:

- `@gitlens/utils` — shared utilities, events, decorators, URI and promise helpers.
- `@gitlens/git` — Git models, provider contracts, parsers that are host-independent, and
  repository services.
- `@gitlens/git-cli` — Git process execution, CLI providers, and CLI-specific parsers.
- `@gitlens/ipc` — optional local IPC discovery/server support for CLI consumers; it does
  not contact a hosted service.
- `@gitlens/core` — the distributable library bundle composed from the packages above.

## Service and repository flow

`src/extension.ts` creates the `Container`. `GitProviderService` owns one `GitService` and
registers the desktop CLI provider. A repository request is routed to a provider, then a
`GitRepositoryService` binds the repository path to the operation providers (branches,
commits, blame, diff, stash, status, worktrees, and so on). The provider caches shared Git
data and invalidates it from repository/watch events.

All Git commands eventually pass through `Git.run()` in `packages/git-cli`. The extension
does not send repository contents to a remote service. Remote URL actions only construct or
open the URL already configured in a local Git remote; optional avatar or hosting links may
make their own network requests when enabled.

## Webviews

The retained webview apps are:

- `src/webviews/apps/commitDetails/` — Inspect commit details, changed files, stash actions,
  and local file operations.
- `src/webviews/apps/rebase/` — manual interactive rebase editor.
- `src/webviews/apps/allowedSigners/` — SSH/Git allowed-signers editor.

Each host uses the same Supertalk RPC stack. A provider in `src/webviews/*Webview*.ts`
creates an `RpcHost` and typed services from `src/webviews/rpc/services/`; the Lit app uses
`RpcController` over VS Code's `postMessage` pipe. Visibility, focus, lifecycle, and state
updates use the shared RPC event helpers. Persistent UI state is stored through the VS Code
webview state API; Git resources are fetched from the host and are not persisted as a cache.

Shared webview components live under `src/webviews/apps/shared/`. Use the accessibility and
styling guidance in `docs/accessibility.md` and `docs/webview-styling.md` when changing them.

## Commands and views

Commands are declared in `contributions.json`; generated command and contribution files are
updated with `pnpm run generate:commandTypes` and `pnpm run generate:contributions`. The main
views are repositories, branches, commits, remotes, stashes, tags, worktrees, contributors,
and search/compare. Inline blame and CodeLens are implemented by the annotation and tracker
services in `src/annotations/` and `src/trackers/`.

## Build and verification

```bash
pnpm install
pnpm run check
pnpm run build
```

`pnpm run build` regenerates contributions, command types, icon metadata, licenses, and
webview bundles. Keep generated output in sync with the source files.
