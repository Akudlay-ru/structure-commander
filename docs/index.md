---
layout: default
title: Structure Commander for Obsidian
---

# Structure Commander

**Manage Markdown as a tree in Obsidian.**

Structure Commander is an Obsidian community plugin for long Markdown documents: specifications, project notes, meeting summaries, documentation, plans, outlines, and any text where hierarchy matters.

It does not just show the outline. It lets you work with it: move branches, change heading levels, fold and unfold sections, renumber outlines, export branches, and navigate long notes without manually dragging text around like a clerk in a paper archive.

[GitHub repository](https://github.com/Akudlay-ru/structure-commander) · [Releases](https://github.com/Akudlay-ru/structure-commander/releases) · [Issues](https://github.com/Akudlay-ru/structure-commander/issues)

---

## What it does

- Move Markdown branches up and down with all nested content.
- Promote and demote headings while keeping branch hierarchy intact.
- Convert between headings, plain text, bullet lists, numbered lists, and alphabetic lists.
- Collapse and expand the current branch.
- Show the document only up to H1, H2, H3, H4, H5, or H6.
- Show all hidden branches again.
- Renumber headings and lists.
- Remove existing numbering.
- Replace numbering with emoji-style numbers.
- Export the current branch to a separate Markdown file.
- Navigate the document through a side structure panel.
- Use a compact toolbar above the editor.
- See active hotkeys directly in tooltips and context menus.

---

## Install from Obsidian

1. Open **Settings**.
2. Go to **Community plugins**.
3. Click **Browse**.
4. Search for **Structure Commander**.
5. Click **Install**.
6. Click **Enable**.

No manual copying into `.obsidian/plugins` once it is available in Community Plugins. Civilization occasionally produces something useful.

---

## Default hotkeys

| Action | Hotkey |
|---|---|
| Move branch up | `Alt + Shift + ↑` |
| Move branch down | `Alt + Shift + ↓` |
| Promote branch | `Alt + Shift + ←` |
| Demote branch | `Alt + Shift + →` |
| Collapse branch | `Alt + ←` |
| Expand branch | `Alt + →` |

All hotkeys can be changed in Obsidian hotkey settings. Structure Commander also shows current hotkeys in menus and tooltips.

---

## How branches work

A branch is the nearest heading above the cursor plus everything below it until the next heading of the same or higher level.

```markdown
# Section A

Text.

## Subsection A.1

More text.

# Section B
```

If the cursor is inside **Section A**, moving the branch down moves `Section A`, `Subsection A.1`, and all nested content below `Section B`.

---

## Editor toolbar

The plugin adds a compact toolbar above the Markdown editor:

```text
[↑] [↓] [←] [→] [−] [+] [Show: Hn ▾] [H? ▾] [№]
```

| Button | Meaning |
|---|---|
| `↑` / `↓` | Move branch up or down |
| `←` / `→` | Promote or demote branch, text, or list item |
| `−` / `+` | Collapse or expand current branch |
| `Show: Hn ▾` | Show document up to a selected heading level, or show everything |
| `H? ▾` | Change current heading level or whole branch root level |
| `№` | Open renumbering tools |

Right-clicking toolbar buttons opens quick hotkey assignment.

---

## Context menu

Right-click in the Markdown editor to access:

```text
Expand / collapse
Show to
Level | Move
Numbering
Export branch
```

The **Show to** submenu lists only heading levels that actually exist in the document. The **Level | Move** submenu contains branch movement and precise promote/demote-to-level actions.

---

## Structure panel

The side panel provides:

- outline-style heading navigation;
- search by heading title;
- depth filter;
- active heading highlight;
- context actions for headings;
- move, fold, unfold, promote, demote, and export actions.

Heading levels are shown visually through indentation and typography instead of repeating `H1`, `H2`, `H3` on every line. A rare triumph over unnecessary labels.

---

## Videos and screenshots

The public demo materials will be placed here.

### Planned short video: Move a branch up and down

Placeholder: show a heading moving together with all nested content.

### Planned short video: Folded branch movement

Placeholder: show that a folded branch stays folded after movement.

### Screenshot: Toolbar

Placeholder: show the editor toolbar with arrows, Show to, H-level menu, and numbering.

### Screenshot: Context menu

Placeholder: show Show to, Level | Move, Numbering, and Export branch.

### Screenshot: Structure panel

Placeholder: show the outline-style panel with search and active heading highlight.

### Screenshot: Export and renumber modals

Placeholder: show export options and renumber preview.

---

## Links

- [Repository](https://github.com/Akudlay-ru/structure-commander)
- [Latest releases](https://github.com/Akudlay-ru/structure-commander/releases)
- [Issues and feature requests](https://github.com/Akudlay-ru/structure-commander/issues)

---

MIT License
