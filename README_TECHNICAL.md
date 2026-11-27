# Denotation: technical manual

How Denotation is built, how to run and test it, and where things live. For using the app, see [README_INSTRUCTION.md](README_INSTRUCTION.md).

## 1. Principles

- Plain HTML, CSS and native ES modules (`<script type="module">`). No framework, no bundler, no build step.
- No third-party code except Lucide icons (a trimmed set, inlined in `public/js/icons/lucide-data.js`). Markdown, CSV, formulas, charts and the UI are all written in house.
- Everything runs in the browser. There is no backend.
- The app must be served over HTTP(S), because ES modules don't load from `file://`.

## 2. Running and testing

```bash
npm start                  # python3 -m http.server 8080 -d public  ->  http://localhost:8080
npm test                   # node --test test/*.test.js  (unit tests, built-in runner, no packages)
node test/e2e/smoke.cjs    # browser smoke test on port 8099 (needs Playwright + Chromium, dev-only)
```

`npm` is only used as a script runner. There are no dependencies to install.

## 3. Layout

```
public/
  index.html            shell: #login, #app (#sidebar + #main), loads js/app.js
  css/style.css         all styles; colour tokens on :root, dark theme via prefers-color-scheme / [data-theme]
  js/
    app.js              entry: boot, hash routing (#page-<id>), global shortcuts
    config.js           storage adapter choice
    store.js            picks and loads a storage adapter
    adapters/           local (localStorage), memory, folder (File System Access, wraps local), artifact-db, firebase (stub)
    zip.js              in-house ZIP read/write (deflate via CompressionStream)
    vault.js            workspace <-> file map: Denotation JSON and vanilla Markdown          (pure)
    workspace.js        all data operations (pages, rows, trash, duplicate, tickets, CSV, export/import)
    schema.js           column types and validation          (pure)
    dbviews.js          filters, sorts, groups, chart/layout helpers (pure)
    formula.js          Excel-like formula engine             (pure)
    pivot.js            pivot tables                           (pure)
    preview.js          record preview: key matching, preset/config resolution (pure)
    csv.js              CSV parse/serialise                    (pure)
    prefs.js            appearance preferences and tokens      (pure)
    ids.js              id generation
    blocks/             block model, markdown, inline formatting, block catalogue (pure)
    icons/              ico(name) helper + Lucide data
    ui/                 rendering: sidebar, pages, block editor, database views, dialogs, settings
test/
  *.test.js             unit tests (node:test)
  e2e/smoke.cjs         browser smoke test
```

"Pure" modules have no DOM access and are the first place to add unit tests.

## 4. Routing

Hash based: `#page-<id>` opens a page. No server rewrites are needed, so it works on any static host, including a GitHub Pages sub-path. Every asset path is relative.

## 5. Storage

All storage goes through `js/store.js`. Each adapter has the same small interface:

```js
{ name, label, auth,
  list(collection, filter?) -> Promise<object[]>,
  get(collection, id)       -> Promise<object|null>,
  set(collection, id, data) -> Promise<void>,
  remove(collection, id)    -> Promise<void> }
```

- `config.adapter: "auto"` uses `artifact-db` inside a Claude artifact, else `local`, else `memory` (with a note in the sidebar footer).
- `local` keys look like `denotion:<collection>:<id>`.
- Collections: `pages` and `rows`. Every record carries `updatedAt` or `createdAt`.
- Keep each record under ~250 KB. Images are embedded as data URLs and shrunk to about 150 KB.
- Preferences live in `localStorage["denotion:prefs"]`.
- Export/Import (sidebar ⋯ menu) goes through `vault.js`: a JSON file, a ZIP or a folder, in **Denotation JSON**
  (`denotation.json` manifest + `pages/<id>.json` + `rows/<id>.json`, full fidelity) or **Markdown** (sibling-folder
  layout, `.csv` databases, `attachments/`, relative links; lossy). Import detects the format by the manifest.
- **Folder adapter** (`adapters/folder.js`, Chromium only): wraps `local` as the working cache and mirrors records to a
  user-picked folder in the Denotation JSON layout. Merge on connect is per-record last-write-wins on `updatedAt`
  (fallback `createdAt`); writes are debounced and serialised per file; deletes are remembered as `tombstones` in the
  cache (not yet in the folder: ticket 004). The directory handle lives in IndexedDB (db `denotation`, store
  `handles`); boot calls `queryPermission` and re-requests on the first user click. `saveRow` stamps `updatedAt`.

## 6. Data model

- **Page types:** `repo` (top-level group), `doc` (blocks), `database` (columns + rows + views; `sourceId` makes it a linked view of another database), `sync` (synced block source).
- **Rows** belong to a database, hold `values[colId]`, and have their own `blocks`, so each row is also a page. Formula columns cache their result in `values[colId]`; `applyFormulas` recomputes them.
- **Record preview block** (`type: "preview"`): `{ dbId, keys, presetId, config, snapshot }`. Database pages may carry
  `primaryKey: <colId>` (default first column) and `previewPresets: [{ id, name, layout, columns }]`. Resolution:
  preset → snapshot (preset deleted) → own config → default.
- **Views:** table, sheet, board, list, gallery, calendar, feed, chart, dashboard, each with its own filters, sorts, groups and layout.

## 7. UI conventions

- `h(tag, props, ...children)` in `ui/dom.js` builds DOM. `replaceChildren` turns `null` into the text "null", so `.filter(Boolean)` child lists.
- Never use native `alert` / `confirm` / `prompt`: use `ui/dialogs.js` and `ui/modal.js`.
- Icons: `ico(name)` from `js/icons/index.js`. Add new icons to `lucide-data.js`; never load them from a CDN.
- Sidebar rows have no inline buttons: right-click, long-press or Shift+F10 opens the page menu.
- Escape all user, CSV, markdown and imported content before it reaches the DOM. No `eval` or `new Function` outside the sandboxed formula engine.

## 8. Theme

Colour tokens are CSS custom properties on `:root`, redefined for dark mode. The accent is one of 24 OKLCH hues (0–345° in 15° steps, chroma 0.16) or grey, stored as `prefs.accent` (`"random"`, `"grey"` or the hue). `"random"`, the default, picks a new hue on each load and never grey. Grey is dark grey in light mode and light grey in dark mode. See `CLAUDE.md` → Theme for the exact formulas.

## 9. Roadmap

1. GitHub Pages deploy and installable app (manifest, icons, service worker, install button).
2. IndexedDB storage with migration from localStorage, plus an optional data folder (File System Access).
3. Google Drive and OneDrive sync, browser-only (no backend).

The details are in `CLAUDE.md`.
