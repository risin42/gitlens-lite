# Library package architecture

The library packages are usable without the VS Code UI. They are split so Git models and
operations remain independent from the host that executes Git.

## Package dependency flow

```text
@gitlens/core
    ├── @gitlens/git-cli ──┐
    ├── @gitlens/git       ├── @gitlens/utils
    └── @gitlens/ipc      ─┘
```

- `@gitlens/utils` contains the common primitives: events, disposables, logging, caching,
  decorators, paths, and URI helpers.
- `@gitlens/git` defines Git models, provider contracts, repository services, and shared
  parsing/formatting logic. It has no VS Code dependency.
- `@gitlens/git-cli` supplies the `Git` process runner, CLI-specific parsers, and the
  `CliGitProvider` implementation.
- `@gitlens/ipc` is an optional local IPC server and discovery-file protocol for tools that
  want to talk to a running local extension host. It is not a hosted API.
- `@gitlens/core` bundles the public library packages for standalone consumers.

## Repository request flow

```text
consumer
  │
  └─ GitService.forRepo(path)
       │
       └─ GitRepositoryService (binds path)
            │
            └─ operation provider (branches, blame, commits, diff, stash, status, ...)
                 │
                 └─ Git.run(cwd: path, arguments)
```

`GitService` selects a provider and caches the repository service. The repository service
binds the path once, so each operation provider can expose a small, path-independent API.
`CliGitProvider` lazily creates operation providers and shares its Git runner and cache. File
watch events invalidate affected cache entries instead of rebuilding the whole service.

## Host boundary

The VS Code extension adapts settings, filesystem access, workspace trust, and change events
to `GitServiceContext`. The library consumes those hooks without importing VS Code. On the
desktop, `GlCliGitProvider` executes the user's installed Git binary. The browser build has no
local process and registers no provider unless its host supplies an implementation.

## Adding an operation

1. Add or update the model and provider contract in `packages/git/src/`.
2. Implement the operation in `packages/git-cli/src/providers/` when it needs Git CLI output.
3. Expose the provider through `CliGitProvider` and the repository service.
4. Run `pnpm run check` and `pnpm run build`.
