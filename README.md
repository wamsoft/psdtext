# psdtext

*[日本語版はこちら / Japanese version](README_ja.md)*

*What changed recently: [CHANGELOG.md](CHANGELOG.md)*

A local tool for listing and rewriting the text layers of a PSD.
It exists so you can do the **text re-editing** — translation, proofreading,
fixing inconsistent wording — without opening Photoshop.

- Layer tree and composite preview side by side; edit the body in place
- **CSV export / import** for bulk replacement (handy for outsourcing translation or review)
- Layers you do not edit are written back byte for byte
- The browser is the UI. One executable, and it exits on its own when you close it

```
psdtext                  start from the file picker
psdtext foo.psd          open a file straight away
psdtext foo.psd --repl   with a REPL (for agents and automated tests)
```

Built from:

| | |
|---|---|
| UI / framework | [wamsoft/appserve](https://github.com/wamsoft/appserve) — local HTTP server + browser UI |
| PSD read/write | [wamsoft/psdparse](https://github.com/wamsoft/psdparse) — pure C++17 PSD reader/writer |

---

## The screen

| Pane | Role |
|---|---|
| Left | Layer tree. Folding, plus visibility toggles for folders and individual layers |
| Centre | **Composite preview** that follows those visibility toggles |
| Right | Editing for the selected text layer (formatting marks, body, position) |

Visibility toggles are **preview-only** and never reach the PSD. "Reset" goes back
to the visibility stored in the file.

Compositing happens on a canvas in the browser, so toggling is instant with no
round trip to the server. Blend modes, opacity and clipping layers are handled
(group blending, adjustment layers and layer effects are not). It is a
**working preview** — the limits, and whichever of them actually affect the PSD
you have open, are shown permanently under the canvas.

Zoom at 100% is **true 1:1** (one image pixel per physical screen pixel); it does
not double in size on a display running at 200% scaling.

The UI is available in English and Japanese. It follows the browser language by
default and can be switched from the toolbar.

### Redrawn text

The text raster inside a PSD is not updated until Photoshop reopens the file, so
**edited text layers are redrawn on the canvas** instead (toggle "Redraw text").
Typesetting — kerning, line-breaking rules, vertical text, transforms — is not
reproduced, so treat it as a check of content and position. Only fonts installed
on this PC can be used; the edit pane says so when one is missing.

## Using it

1. Start `psdtext` and a browser opens (Edge / Chrome in app mode)
2. "Open…" and pick a PSD — **dropping a PSD onto `psdtext.exe` (or a shortcut)
   opens it too**, and the dialog starts in the folder you used last
3. Select a text layer in the tree on the left and edit it on the right
4. **Apply** (Ctrl+Enter) to put it into the document, **Save** (Ctrl+S) to write the file

**Ctrl+Shift+Enter** applies and moves straight to the next text layer with its
body selected, so you can keep retyping; **Alt+↑/↓** moves between text layers.
The "List" toggles on the left narrow the tree down to text / unsaved / visible
layers.

The font list shows **the name you know a font by** (read out of the font files,
so Japanese fonts show their Japanese names) with the PostScript name the PSD
stores alongside; either is searchable. `★` puts a font in a **preset** so it
comes up first next time, and presets are named — one per project works well.

The window size and position are remembered for next time (when the browser is
already running it creates the window itself, so this does not always apply).

**When psdtext exits, its browser window closes itself** (browsers that refuse to
close a window say so on the page instead) — so you never end up with a pile of
dead-looking windows and no idea which one is live.

Saving over the original keeps it as `<name>.psd.bak` (an existing `.bak` is never
overwritten). Enter a path in the save dialog to save under a different name.

Formatting is edited through **marks**. The edit box shows no tags — instead a
`◆` chip sits wherever the formatting changes. What you edit is **the mark the
caret belongs to**: put the caret anywhere and the mark in effect there appears in
the panel. **With no mark before the caret you are on the base** — the initial
formatting of the whole layer — so changing it changes everything that carries no
explicit formatting (which is all most edits need).

Chips can be clicked to select, and deleted with `Backspace` like a single
character. Selecting a range of text formats just that range. Formatting changes
are applied immediately; only typed text needs "Apply".

**Layers can be selected in bulk** (Ctrl+click to add or remove, Shift+click for a
range). With two or more selected the right pane turns into bulk operations:
initial formatting (font / size / colour / B·I·U / alignment) for all of them,
copy & paste formatting, **duplicate with a name prefix**, and CSV export limited
to the selection. Duplication **carries the layer mask along**, which makes it
usable as the groundwork for another language — and since the copies stay
selected, a bulk font change follows in one more click.

**▲▼** at the bottom of the left pane reorder within the same level (folders move
with their contents). **Duplicate** lets you set the name and body on the spot, so
rewriting the body makes it, in effect, "add a new text layer".

Text layer **position and text box** can be changed from the number fields on the
right, by dragging on the preview, or with the arrow keys (Shift for 10px). Moving
a layer moves the raster stored in the PSD along with it, so nothing looks
displaced before Photoshop reopens the file.

**Renaming a layer**: double-click the name in the tree, or select it and press
`F2` (or the "Rename" button). Enter commits, Escape cancels. Works on any layer.

Everything is documented inside the app itself (`?` button or <kbd>F1</kbd>).

### Formatted text (tags)

PSD text carries its formatting as a sequence of runs (consecutive characters
sharing one style), which cannot be expressed in a CSV cell. The runs are
therefore folded into the body as tags. **The editor shows those tags as `◆`
chips**, so the notation itself only shows up in CSV and the API.

```
text test [color=#F6005D]テキスト
[align=right][b]TEST[font=SourceHanSansJP-Normal][size=33.3333][color=#0017F6][/b]フォント変更
[align=center][font=HGPKyokashotai]別のフォント
```

**There are no closing tags.** A tag changes the state from that point onward and
stays in effect until the next one. PSD runs are a flat sequence rather than a
nested structure, so this maps directly onto it and there is no nesting for a
translator to accidentally break.

| Tag | Effect |
|---|---|
| `[font=name]` | Font from here on. A name the PSD does not have is appended to its FontSet |
| `[size=48]` | Font size in px (decimals allowed) |
| `[color=#FF0000]` | Text colour |
| `[b]` `[i]` `[u]` | Bold / italic / underline **on** |
| `[/b]` `[/i]` `[/u]` | The same, **off** |
| `[/font]` `[/size]` `[/color]` | Return that attribute to the base |
| `[reset]` | Return everything to the base |
| `[align=left\|right\|center]` | Paragraph alignment; put it at the start of the paragraph |
| `[[` | A literal `[` |

- **Uniformly styled text carries no tags at all**, so ordinary translation work
  never has to deal with them
- The base is the style of the first run **as the file was loaded**, and it does
  not move as you edit: `[/color]` always means "the colour this file was opened
  with". Changing the initial formatting lays a mark over that base, which is why
  "Revert" always gets you back
- Formatting a range does not produce a closing tag either — it places a mark at
  the end that **restores the formatting that was in effect there**, so it cannot
  break whatever the surrounding text had
- Tags that cannot be understood stay as plain characters, so the body is never lost
- The generated form is **stable across round trips** — edit, save, reopen and you
  get the same string back

In CSV the initial formatting sits in its own columns, and this notation only
shows up in the `tags` column — for rows that carry formatting inside the body.

### Bulk editing with CSV

**Export CSV** writes `<name>_texts.csv` **next to the PSD** by default, and the
import dialog starts from that same path — no hunting for the file (a browser
download is still one click away). A CSV can also be dropped onto the window.

Exports are UTF-8 with a BOM and CRLF, so Excel opens them directly; imports also
accept **the Shift-JIS file Excel saves by default**, and the report says which
encoding it read. "Apply" needs at least one differing row, and tells you why when
there is none. The format:

```csv
lyid,path,font,size,color,align,text,tags
2,"dialog/name",NotoSansJP-Bold,48,#202020,left,"Hello",
4,"dialog/body",NotoSansJP-Regular,32,#202020,center,"first line
second line",
```

- **The initial formatting has its own columns** (font / size / colour / align),
  so nothing is mixed into the body cell and a whole column can be filled in at
  once in a spreadsheet
- The `text` column is the **plain body**; a newline inside the cell becomes a
  paragraph break
- The `tags` column is filled in **only for rows that carry formatting inside the
  body**. On import, a row whose body you did not touch keeps that formatting; a
  row you rewrote becomes initial formatting + plain text
- An empty cell means "leave as is"
- **The older shape (tags folded into `text`) still imports**
- Layers are matched by **`lyid` (Photoshop's persistent layer ID)**, so
  reordering or renaming layers does not break the mapping. Rows without an
  `lyid` fall back to the `path` column (reported as unresolved when the name is
  ambiguous)
- Column order is free and extra columns are ignored

**Import CSV** first performs a **check only** pass and reports how many rows
would change, stay identical, or fail to resolve. Press "Apply" once the report
looks right (that only touches the in-memory document — the file is written by
"Save").

---

## Building

All you need is CMake 3.16+ and a C++17 compiler. The dependencies (appserve,
psdparse, zlib) are fetched by CMake.

```bash
cmake --preset windows          # MSVC (from a Developer Command Prompt)
cmake --build --preset windows-rel
```

If you are working on appserve or psdparse at the same time, a checkout at
`../appserve` / `../psdparse` is **picked up automatically** in preference to
fetching. To be explicit:

```bash
cmake --preset windows -DPSDTEXT_APPSERVE_DIR=D:/test/appserve \
                       -DPSDTEXT_PSDPARSE_DIR=D:/test/psdparse
```

Edits under `web/` need only a browser reload (during development the `web/`
directory next to the current directory or the executable wins; a release build
uses the zip embedded in the executable).

---

## API (for derived tools and automation)

Every route requires the `X-App-Token` header (issued at startup and handed to the
UI through the URL).

| Route | Description |
|---|---|
| `POST /api/psd/open` | Open `{path}`. Returns document info, tree and text list |
| `GET  /api/psd/info` | Summary of the open document (path, layer count, unsaved count) |
| `GET  /api/psd/tree` | Every layer (index / lyid / parent / depth / kind / rect) |
| `GET  /api/psd/texts` | Text layers (body, base style — font/size/colour/B/I/U —, alignment, dirty) |
| `POST /api/psd/text` | `{index, text}` replaces the body |
| `POST /api/psd/revert` | `{index}` returns the layer to the text as loaded |
| `POST /api/psd/name` | `{index, name}` renames the layer |
| `POST /api/psd/align` | `{index, paragraph?, align}` changes alignment (all paragraphs if omitted) |
| `POST /api/psd/duplicate` | `{index, name?, text?}` duplicates a layer (rewrite the body to add one) |
| `POST /api/psd/move` | `{index, direction}` moves one step up/down within the level (folders move with their contents) |
| `POST /api/psd/place` | `{index, dx, dy}` to move / `{index, width, height}` for the text box |
| `POST /api/psd/save` | `{path?, backup?}` saves (overwrites when path is omitted) |
| `GET  /api/psd/image?index=N` | The layer as raw RGBA (`X-Image-Width/Height`) |
| `GET  /api/psd/export` | Download the text as CSV |
| `POST /api/psd/export` | `{path?, indices?}` writes the CSV to a file (next to the PSD by default) |
| `POST /api/psd/import` | Import a CSV — raw bytes, `{csv}` or `{path}`. `?apply=0` checks only |
| `GET  /api/app/settings` | Settings that outlive the window (last folder and so on) |
| `POST /api/app/settings` | Merge in the given keys |

appserve's standard `/api/fs/*` routes are available as well, for picking files.

### REPL

`--repl` (interactive) / `--replfile=DIR` (agents) / `POST /_app/repl` (curl).

| Command | Description |
|---|---|
| `.psd` | Information about the open document |
| `.texts` | List the text layers (`*` = unsaved) |
| `.settext <index> <text>` | Replace a body |
| `.b state` | Inspect the UI state |
| `.b call select 3` | Move the selection |
| `.b call lang en` | Switch the display language |
| `.b call marks` | Inspect the formatting marks (base, body, mark list) |
| `.b call marksel base` | Choose what the panel edits (`{"mark":2}` / `{"range":[5,9]}` / `{"at":10}`) |
| `.b call fmt {"color":"#FF0000"}` | Format the current target (a value / `null` = back to base / `"keep"` = drop the spec) |

See appserve's [docs/REPL.md](https://github.com/wamsoft/appserve/blob/master/docs/REPL.md).

---

## Limits

- Adding a text layer is built on duplicating an existing one (so that the
  structure Photoshop accepts is preserved exactly). Formatting and position are
  inherited from the source, and a PSD without a single text layer cannot get one
- Position and text box can be changed for text layers only; moving or scaling
  image layers is done in Photoshop
- Text cannot be rotated or transformed (only the translation part of the matrix)
- Reordering is limited to one level; layers cannot be moved in or out of folders
- The composite preview is approximate: adjustment layers, layer effects and group
  blending are not applied, and blend modes the browser lacks are approximated
- The composite thumbnail Photoshop stores in the file stays stale after saving
- Resizing the text box only reflows paragraph text; for point text Photoshop
  rebuilds the box from the glyphs

## Packaging and releases

`appserve_package()` (provided by appserve) builds the zip and the installer, and
pushing a tag makes GitHub Actions publish a release.

```bash
cmake --build --preset windows-rel
cpack --config build/windows/CPackConfig.cmake -C Release -B dist   # build locally
git tag v0.3.0 && git push origin v0.3.0                            # publish
```

The distributable is just `psdtext.exe` plus README and LICENSE. The UI is embedded
in the executable and the dependencies (appserve / psdparse / zlib) are linked
statically, so there are no DLLs.

To make a release reproducible, pin the dependencies to tags:

```bash
cmake -B build -DPSDTEXT_APPSERVE_TAG=v0.1.0 -DPSDTEXT_PSDPARSE_TAG=v0.9.0
```

See appserve's [docs/RELEASE.md](https://github.com/wamsoft/appserve/blob/master/docs/RELEASE.md).

## License

MIT
