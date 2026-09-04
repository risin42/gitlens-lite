# GitLens-lite

A lightweight build of [GitLens](https://github.com/gitkraken/vscode-gitlens), retaining its community features and Git workflows.

## Included

- Inspect with commit details, file changes, native context menus, and stash operations.
- Inline blame, annotations, CodeLens, and hovers.
- Repository, branch, commit, file/line history, remote, tag, stash, and comparison views.
- Git commands, patches, worktrees, and the manual interactive Rebase editor.
- Remote URL links and user-configured autolinks.

## Removed

AI Slop, Online-only features and their dedicated packages and UI are omitted.
The build has no account or usage-reporting pipeline.
No GitKraken sign-in is needed. Git fetch/push uses your existing Git authentication.
Remote links and optional community avatar fetching can still access the network.

## Build and install

Requires Node.js 24+ and pnpm 11+.

```bash
pnpm install
pnpm run build
pnpm run bundle
pnpm run package
```

Install the resulting VSIX with VS Code's **Install from VSIX** command.

## Attribution and licenses

Original GitLens copyright and attribution remain with its authors and contributors. See [LICENSE](LICENSE). Third-party licenses remain applicable.
