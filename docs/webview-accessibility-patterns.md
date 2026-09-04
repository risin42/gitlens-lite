# Webview keyboard navigation and focus patterns

Reusable patterns for Lit webviews. The requirements checklist is in
`docs/accessibility.md`; these examples explain how to implement it with the shared controls.

## Roving tabindex groups

A toolbar or list of related controls should expose one tab stop. Give the active control
`tabindex="0"`, give the other controls `tabindex="-1"`, and move the active index with Arrow,
Home, and End. Reuse `RovingTabindexController` or `action-nav` from
`src/webviews/apps/shared/` instead of hand-rolling a second controller. Skip disabled controls
and do not consume modified arrows that belong to a parent shortcut.

## Virtualized lists

Use one focus host with `aria-activedescendant` when rows are recycled. Every active row or child
action needs a stable ID. A row click should update the active index and focus the host so the
next Arrow key navigates the clicked row. If a focused row is recycled, restore focus only when
the browser has actually fallen back to `body`; never steal a deliberate focus move.

## Menus and overlays

Keep DOM focus on a menu button when its popup uses `aria-activedescendant`; moving focus into
hoisted popup content can break the owner’s focus model. Keep the owner visually expanded while a
child has focus, mirror the focus ring onto any visible overlay copy, and close the overlay on
Escape. Restore focus to the opener after closing.

## Focus and navigation

An action that selects another row, opens a file, or scrolls to a destination must move focus to
that destination. Focus rings should be visible against the VS Code theme and should not be
clipped by a row decoration. Tooltips must open on keyboard focus as well as pointer hover; an
`aria-activedescendant` cursor needs an explicit tooltip call because it does not emit `focusin`.

## Verification checklist

- Tab enters and leaves each control group once.
- Arrow, Home, End, Enter, Space, and Escape work without a pointer.
- Focus remains visible after filtering, reload, virtualization, and overlay close.
- Screen-reader names and state attributes (`aria-expanded`, `aria-selected`, and
  `aria-disabled`) describe the current control state.
