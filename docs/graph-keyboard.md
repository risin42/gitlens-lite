# Webview keyboard architecture

This note describes the shared keyboard conventions used by the retained Inspect, Rebase, and
Allowed Signers webviews. The filename is kept for compatibility with existing development
links; no separate graph surface is part of this build.

## Keymap layers

Keyboard handling belongs to the surface that owns the focused control. Shared controls use the
key helpers in `packages/utils/src/keys/` and the components under
`src/webviews/apps/shared/`. A surface-level dispatcher may add a binding only when it does not
steal text-entry keys from an input or select.

- Use arrow keys for navigation within a list or tree.
- Use Enter and Space for activation of custom buttons and rows.
- Use Escape to close the topmost popover/dialog and restore the trigger focus.
- Keep modifier shortcuts explicit and let the focused input consume ordinary typing.

## Focus and overlays

Use a roving tabindex for a group of related controls and keep one logical tab stop per group.
When a virtualized list owns focus, use `aria-activedescendant` with stable IDs rather than
moving DOM focus into recycled rows. A popover must not strand focus behind its overlay; close it
on Escape and restore focus to the opener.

Every keyboard-accessible control needs a visible focus indicator and an accessible name. Tooltips
must appear for keyboard focus as well as pointer hover. Navigation that changes the selected
item or scroll position should move focus to the destination.

## Adding a binding

1. Identify the owning component and its focus scope.
2. Add the smallest binding that leaves text fields and native controls alone.
3. Describe the binding in the surface's shortcut help when one exists.
4. Verify keyboard-only navigation, Escape behavior, focus restoration, and a reload of the
   webview.
