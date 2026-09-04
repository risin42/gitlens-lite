# Webview architecture

The retained webviews use one typed transport: Supertalk RPC over VS Code's `postMessage`
pipe. Host providers create an `RpcHost` and expose services from
`src/webviews/rpc/services/`; Lit applications connect through `RpcController`.

## Surfaces and services

| Surface                  | Host provider              | App entry                               | Main service                     |
| ------------------------ | -------------------------- | --------------------------------------- | -------------------------------- |
| Inspect / Commit Details | `commitDetailsWebview.ts`  | `apps/commitDetails/commitDetails.ts`   | shared services + commit details |
| Rebase                   | `rebaseWebviewProvider.ts` | `apps/rebase/rebase.ts`                 | `rebaseService.ts`               |
| Allowed Signers          | `allowedSignersWebview.ts` | `apps/allowedSigners/allowedSigners.ts` | `allowedSignersService.ts`       |

Shared services cover repository resources, Git operations, files, configuration, storage,
and commands. A surface may add a small view-specific service, but it should use the same RPC
connection and event helpers.

## Session lifecycle

The client announces a new session after its scripts are ready. `RpcHost` serves the session and
the client validates it through the shared `webview.connect()` call. A validation releases
subscriptions belonging to older or interrupted sessions, preventing duplicate event handlers
after a webview reload. Visibility and focus are sent as buffered events and re-emitted in the
app as window custom events.

When an RPC method awaits resource acquisition before registering a subscription, capture the
caller session and reserve it before the await. Release that reservation in `finally`; this
keeps a reload from installing a listener for a session that has already been replaced.

## State and persistence

Keep Git resources in the host and request them through RPC. Keep navigation and UI preferences
in the app's signal/state group and persist them through `HostStorage` (the VS Code webview
state API). Runtime and derived values stay in memory. Do not persist fetched repository data.

The initial HTML context may carry a serialized value for bootstrap-only state. Use the tagged
value serializer/reviver in `src/system/ipcSerialize.ts`; do not parse those values as plain JSON
when they may contain dates or URIs.

## Webview implementation rules

- Build components with Lit and shared primitives under `apps/shared/`.
- Register RPC events with `createRpcEvent`/`createRpcEventSubscription` or the
  `trackRpcRegistration` helper; direct tracker calls lose session ownership.
- Dispose event listeners, observers, and subscriptions in `disconnectedCallback()` or the
  owning disposable.
- Sequence a durable write before an action that closes, moves, or reloads a webview. Await the
  write instead of relying on a deferred message that may be lost during teardown.
- Keep focus, keyboard, ARIA, and contrast behavior aligned with `docs/accessibility.md` and
  `docs/webview-accessibility-patterns.md`.
