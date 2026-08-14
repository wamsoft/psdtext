# Changelog

What changed in psdtext, written from **the point of view of someone using it**.
On release, rename the "Unreleased" heading to the version number and start a new
"Unreleased" above it. The reasoning behind a change belongs in its commit message.

日本語: [CHANGELOG_ja.md](CHANGELOG_ja.md)

---

## Unreleased

---

## 0.3.0 — 2026-08-15

### Edit as a list

- **Layer names can be changed in the table.** The name column used to be
  read-only
- **"Show every layer" lists folders and images too.** Only their name can be
  changed — the body and formatting cells stay inert
- **Copy and paste now target the columns you pick**, either with the checkbox
  in each header or with the body only / formatting only / layer name only /
  everything but the name / all buttons. Paste (Ctrl+V) starts at the cell the
  cursor is in and spreads right across the selected columns; with no cell
  focused it fills them from the top row. A sheet of nothing but translations
  drops straight in
- **Copy table** puts the selected columns on the clipboard as tab-separated
  text. Bodies containing newlines are quoted with `"`, so rows survive the
  round trip through Excel
- **The font cell suggests fonts as you type** (local names work too). The
  suggestions are limited to **the fonts this PSD uses plus the ones you starred
  (★)**; `…` opens the usual picker for everything else

### Fixed

- **Paths with non-ASCII characters given on the command line now open**
  (`psdtext 画面.psd`, file associations, shortcut arguments). The encoding was
  being read wrong
- **Console log output is no longer mojibake** — `—` and Japanese paths came out
  garbled
- **The bottom of the window is no longer cut off when the window is narrow.**
  The layout assumed a fixed toolbar height, so once the toolbar wrapped, the
  buttons under the layer tree fell outside the window

### Layer names

- **Rename layers in bulk** from "Rename…" under the tree: find and replace
  (regular expressions included), a prefix and suffix, and numbering — with a
  "now → after" list to check before applying. Folders and images count too
- The number can go **anywhere in the result**: write `{n}` in "Replace with",
  "Add to the front" or "Add to the end". `{n:3}` sets the width inline
  (`007`), `{n+10}` shifts it, and it mixes with back-references
  (`tx_{n:2}_$1`)

---

## 0.2.1 — 2026-08-14

- **Fixed: the multi-selection pane never went away.** Selecting a single layer
  again, or opening another PSD, left the "N layers together" list and its
  buttons on screen

---

## 0.2.0 — 2026-08-14

### CSV

- **Fixed: importing a CSV never applied anything.** Building the list of
  differences threw, which left the "Apply" button disabled for good
- **Shift_JIS CSVs saved by Excel now import as-is** instead of coming in as
  mojibake. The detected encoding is shown in the dialog
- **The export folder is remembered**, and the import dialog opens there too
- **Export only the layers you selected** (it used to be all-or-nothing)
- **The initial formatting now lives in its own columns.** With font / size /
  colour / alignment packed into the same cell as the text, Excel could not
  paste a column at a time. Formatting that changes mid-text stays in `tags`
- The import report says **why** a row was not applied (no such layer, nothing
  changed, and so on)

### Working on many layers at once

- **Select several layers** (Ctrl-click / Shift-click)
- **Apply a font, size, colour or alignment to all of them at once**, and
  **copy formatting from one layer and paste it onto the rest**
- **Duplicate the whole selection**, optionally prefixing the layer names — one
  step to lay the groundwork for another language. Masks are duplicated along
  with the layer (CI checks this on every run)
- **Sheet editing**: put the selected layers' text and initial formatting in a
  table and edit them there. Paste from Excel to fill it in, no CSV round trip

### Fonts

- **Fonts are listed under the name you know them by** (Japanese fonts show
  their Japanese names), with the PostScript name the PSD stores alongside.
  Either name is searchable
- **Presets** (`★`): fonts you use often come up first, and presets are named,
  so you can keep one per project

### Fewer steps

- **The last folder you opened is remembered**
- **Filter the layer list** (text layers only / by name) — separate from the
  visibility toggles, this narrows the list itself
- **Ctrl+Shift+Enter applies and moves to the next text layer**, with the text
  selected on arrival so you can type straight over it. Ctrl+&uarr; / Ctrl+&darr; move
  between layers
- **A CSV can be dropped onto the window.** A PSD cannot: the browser hands over
  the contents but not the path, so psdtext has nothing to open — drop it onto
  `psdtext.exe` (or its shortcut) instead. Dropping one on the window says so
- **The window size and position are remembered**
- Fixed: a dialog closed when a drag that started inside it ended outside,
  which made pasting a path fiddly

---

## 0.1.1 — 2026-08-14

- **Reworked around formatting marks.** The text no longer shows tags; a mark
  (◆) sits where the formatting changes. The mark your caret is in is the one
  you edit, and it can be deleted
- **Colour can now be set**
- **The formatting a layer was loaded with (the base) is edited separately from
  the changes after it.** Most of the time only the base needs changing, so the
  base is a plain set of pickers while marks and ranges go through a button
- **Formatting a selected range no longer inserts a closing tag**; it puts back
  the formatting that follows the range instead
- **The position fields moved directly under the position display**, so the
  values before the edit stay visible above them
- **Fixed: formatting leaked into other layers and could not be reverted.** The
  base is now fixed at load time and run styles are written back as absolute values
- **When psdtext exits, its browser window closes itself**
- The formatting-mark logic has unit tests that run in CI

## 0.1.0 — 2026-08-14

First release.

- List the text layers in a PSD, rewrite them and save the file back
- Composite preview, per-group visibility toggles, provisional text rendering
- Tag notation for formatted text, alignment, duplicating / moving / renaming layers
- Editing text position and the text box (numbers / drag / arrow keys)
- CSV export and import
- Built-in help, English / Japanese UI
- Windows and Linux packages built by GitHub Actions
