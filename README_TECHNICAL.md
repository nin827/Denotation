# Denotation: technical manual

How Denotation is built, how to run and test it, and where things live. For using the app, see [README_INSTRUCTION.md](README_INSTRUCTION.md).

## 1. Principles

- Plain HTML, CSS and native ES modules (`<script type="module">`). No framework, no bundler, no build step.
- No third-party code except Lucide icons (a trimmed set, inlined in `source/app/js/icons/lucide-data.js`). Markdown, CSV, formulas, charts and the UI are all written in house.
- Everything runs in the browser. There is no backend.
- The app must be served over HTTP(S), because ES modules don't load from `file://`.

## 2. Running and testing

```bash
npm start                  # python3 -m http.server 8080 -d source/app  ->  http://localhost:8080
npm test                   # node --test work/test/*.test.js  (unit tests, built-in runner, no packages)
node work/test/e2e/smoke.cjs    # browser smoke test on port 8099 (needs Playwright + Chromium, dev-only)
node work/test/e2e/bigdata.cjs  # large-data check (5000-row windowed table/sheet, chunked boards), PORT env, default 8099
```

`npm` is only used as a script runner. There are no dependencies to install.

### Math

Inline `{{math:<latex>}}` (≤ 400 characters; the token is capped at `MATH_TOKEN_MAX` 1400 in `inline.js` because
escaping doubles backslashes) and block `{type:"math", text}` (≤ 4000). `js/math/latex.js` is pure (token escape,
`$…$` → chip, `$$` blocks). `js/math/katex.js` lazy-loads `vendor/katex/` (KaTeX 0.19.1, MIT, ESM build renamed
`katex.esm.js` so the precache picks it up; woff2 fonts only) and links its CSS on first use. Options: `trust:false`,
`strict:"ignore"`, `maxSize:20`, `maxExpand:200`; output is built by KaTeX DOM calls, never `innerHTML`. UI in
`ui/mathUi.js`, registered by `ui/plugins/math.js`. Tests: `work/test/math.test.js`, `work/test/e2e/math.cjs`.

### Content-Security-Policy and token lock

- A CSP `<meta>` in `source/app/index.html` (Pages can't send headers): `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; style-src-elem 'self'; img-src 'self' data: blob: https:; font-src 'self';
  connect-src 'self'` + the Google / Microsoft API, token and OneDrive download hosts; `frame-src 'self'
  https://accounts.google.com` (silent Google renewal); `worker-src`, `manifest-src 'self'`; `object-src 'none';
  base-uri 'none'; form-action 'self'`. Scripts are same-origin files only (no inline script, no eval); `<style>`
  elements are blocked while style attributes are allowed (`h()` and SVG use them). `frame-ancestors` can't be set in a
  meta. Add new cloud hosts to `connect-src` (`work/test/csp.test.js` checks the adapters). The root `index.html` has a
  strict CSP allowing its `<style>` by hash (the test prints the expected hash). E2E:
  `node -r ./work/test/e2e/csp-watch.cjs work/test/e2e/<test>.cjs` fails on any violation; smoke.cjs has it built in.
- Sign-in tokens (`tok:*` in IndexedDB `handles`) are encrypted while the PIN lock is on with a random AES-GCM key TK,
  wrapped by PBKDF2(PIN) in record `tokvault` (`adapters/tokenLock.js`; AAD binds each envelope to its name). The PIN
  opens TK at unlock and locking drops it; while locked, providers throw code `locked`, folder.js shows "Locked", and
  `retryLocked()` resumes after unlock. A redirect sign-in that returns while locked finishes after unlock
  (`finishDeferredRedirect`). PIN set encrypts, change re-wraps TK, remove decrypts. PIN records and `tokvault`
  accept 1,000–10,000,000 PBKDF2 iterations only.

### Follow-ups (ticket 016, 020)

- Cloud folder identity: provider, folder name (case-insensitive), Drive space and account (`sameCloudFolder` in
  `adapters/locations.js`); `addLoc` and the redirect sign-in refuse a duplicate. In auto mode the 30 s poll retries a
  main in the "error" state with a quiet merge.
- Table blocks get `colIds` (stable column ids for data-source chips) and `colSeq` (never reused) on the first column
  insert, delete or shrink; before that ids are positional `c0…`. `tableColIds(block)` returns them.
- `formulaRefresh.js`: after a repository's constants change, `refreshFormulaCaches` recomputes its databases' formula
  caches at idle time in chunks of 200 rows, so the MCP server sees fresh values. A newer change cancels the run.
- `view.freeze` counts real columns; `freezeCount` maps it onto shown columns including collapsed-group stubs. Sheet
  header rows stack sticky (`stackHeadRows`).
- `content-visibility: auto` on `.blk-wrap` was measured (`work/test/e2e/blockperf.cjs`) and rejected: slower first
  paint, clipped block handle, wrong TOC jump distance.

### Inline charts

Chip `{{chart:<json>}}` (≤ 4000 characters, `CHART_TOKEN_MAX`) and block `chart` share one spec: `k` kind (spark, bar,
pie, progress), data source (`s` numbers / database column with view, read-as and aggregate / formula), `h` hue, `t`
caption, `m` progress maximum, `z` block size. `js/chart/chart.js` is pure (cleaning, numbers, downsampling to 200
points, pie "Other" past 12 slices, SVG geometry, text alternative, Markdown fenced `chart` block). `ui/chartUi.js` draws
and loads data; `watchChart` listens to `ws.onDataChange` (debounced 300 ms) and stops once the element leaves the page.
Formula sources use `runFormula` from `ui/inlineChips.js`. Registered by `ui/plugins/chart.js`.

### Function graphs

Formula precedence (high to low): primary and postfix `%`; `^` (right-assoc, exponent is a unary expression); unary
`-`/`+`; `* /`; `+ -`; `&`; comparisons (`parse()` in `formula.js`: `unary -> pow -> postfix`).


Block `{type:"plot", fns:[{expr, hue?}], xmin, xmax, ymin?, ymax?, points, grid}` and chip `{{plot:<json>}}` (short keys,
argument ≤ 1000 characters, `PLOT_TOKEN_MAX` in `inline.js`). `js/plot/plot.js` is pure: `cleanPlot`, `compileExpr`
(formula engine, `x` via the constant hook, then pi/e/tau and repository constants), `sampleFn` / `refineSamples`
(401 samples, 120 ms / 1800-evaluation budget, breaks at poles and jumps), `plotModel`, `niceTicks`,
`serializePlot` / `parsePlot` (Markdown fenced `plot` block), `plotToArg` / `plotFromArg`. UI in `ui/plotUi.js`,
registered by `ui/plugins/plot.js`. Chip kinds may supply `action(el, ctx, apply)` for clicks (`chipAction`).
Formula engine: SIN, COS, TAN, ASIN, ACOS, ATAN, ATAN2, SINH, COSH, TANH, CBRT, RADIANS, DEGREES (radians).

### Flowchart block

Stored as `{ type: "flow", layout, dir, rotate, turn, spacing, nodes: [{id, text, shape, hue?, bg?}], edges: [{from, to,
label?, style?, arrow?}] }`. `js/flow/layout.js` is pure (Node-tested): `cleanFlow` (repairs and limits data, idempotent),
`parseFlow` / `serializeFlow` (quick syntax), `layoutFlow` (layered with back-edge removal, dummy nodes and barycentre
ordering; ring; tree; row; grid), `shapeGeometry`, `measureNode`. `ui/flowBlock.js` renders inline SVG with
`createElementNS` and `textContent` only; settings go through `setBlockMenu`. Registered by `ui/plugins/flowchart.js`.
Markdown: a fenced `flow` block, first line `# layout: …, dir: …, rotate: …, turn: …, spacing: …`, then the quick syntax.
`hue` colours outline and text only; `bg` is the fill. After routing, `nudgeLabels` moves labels off boxes; in grid layout an edge that would cross a box is rerouted orthogonally along the cell gaps (`gridRoute`). Box anchors: `#page-<pageId>~<nodeId>` (`parseHash` returns `box`; `focusFlowBox` highlights it); stored as a Markdown link, counted as a page link by `PAGE_HREF` in `links.js`.
Tests: `work/test/flow-layout.test.js`, `work/test/e2e/flowchart.cjs`.

### Hardening (from the fuzz tests)

- `pageProps.safeUrl` cleans like a browser (tab / CR / LF and edge control characters removed) before the scheme
  check; only http(s), mailto and parseable same-origin relative links are kept.
- `terms.termsOf` / `categoriesOf` return cleaned lists cached per stored array: save new arrays, never edit
  `repo.terms` in place. `hueStyle` only writes a finite number.
- Ancestor walks (`isTrashed`, `isArchived`, `inTemplate`, `ancestors`, the permissions chain) have no depth cap and are
  guarded against parent loops; permissions fail closed.
- The local adapter skips and logs corrupt records. ZIP inflation stops at each entry's declared size. Key files must
  use 1,000–10,000,000 PBKDF2 iterations. CSV export prefixes `'` to text cells starting with `= + - @`, tab or CR.
- Inline parsing is linear: `{{img:…}}` scans fail early once a part can't be valid, and `findClose` skips `{{…}}`
  tokens and code spans and remembers that a delimiter has no closer. Embeds nest at most 5 deep and expand at most
  2000 times per export or outermost chip (`EMBED_MAX_DEPTH`, `EMBED_MAX_EXPANSIONS` in `links.js`).
- Formula `*`/`?` criteria use a non-backtracking matcher, `REPT` results are capped at 1e6 characters, and key access
  reads own keys only. `parseType` returns a parse error for very deeply nested type text. Graph rules and positions
  treat names like `__proto__` and `constructor` as data. Markdown export escapes plain lines that would import as
  another block type; the importer removes the escape.
- Block nesting is capped at `MAX_DEPTH` (100, `blocks/model.js`) by `normalizeBlocks` on load: deeper blocks move up
  to the deepest allowed level as siblings, keeping text and order. `blocksToMarkdown` also writes past the cap flat.
- Sync: equal `updatedAt` with different content (compared with `stableJson`, key-sorted) → merge keeps the copy whose
  stable JSON sorts last, so devices converge; Push / Pull overwrite such copies. Identical records are never rewritten.
- CSV import keeps `\r` inside quoted cells; outside quotes CRLF, CR or LF ends a row.

### Fuzz tests

`work/test/fuzz-*.test.js` are seeded, reproducible fuzz tests (part of `npm test`, a few seconds each). Shared helpers
are in `work/test/fixtures/fuzz.js` (in-house PRNG, payload lists, growth/timing helpers).

- Security: XSS payloads through inline tokens, links, props, markdown, CSV and vault paths; prototype pollution through
  prefs, permissions, sync manifests, typespec, JSON import, terms and graph rules; MCP path / symlink / permission
  checks; ZIP slip, bombs and corrupt entries; crypto envelope tampering; OAuth state / nonce / replay.
- Stability: round trips (markdown, CSV, inline tokens, wiki syntax, typespec, sizes), random workspace operation
  sequences (tree, Trash/Archive, link index vs a full rescan), sync convergence and tombstones, formula engine.
- Performance: growth checks (time ratio vs input ratio) with printed timings; superlinear cases fail.

A failure prints `[fuzz <name> seed=… case=… (FUZZ_SEED=…)]`; replay with `FUZZ_SEED=<n> node --test <file>`. Env:
`FUZZ_SEED` (base seed), `FUZZ_RUNS` (case multiplier), `FUZZ_HEAVY=1` (big perf sizes). Known bugs are pinned as
`{ todo: "BUG: …" }` tests so the suite stays green; remove the todo when fixed.

`node work/test/e2e/fuzz-xss.cjs` (PORT 8096–8099, default 8097) seeds a payload-filled workspace and renders every
page, row, Trash, Archive, the graph, quick find and term cards. It fails if a payload runs or the DOM gets `on*`
attributes, script/iframe elements, `javascript:`/`data:text` URLs or injected inline CSS. Known issues print as
`KNOWN` (`FUZZ_STRICT=1` fails on them).

### Deploy and PWA

- **Deploy:** `.github/workflows/pages.yml` publishes `source/app/` to GitHub Pages on every push to `main` (and on manual
  dispatch), after `node work/tools/gen-sw-files.mjs`. `source/app/.nojekyll` is present. One-time setup: Settings → Pages →
  Source: **GitHub Actions**.
- **Files:** `manifest.webmanifest` (relative `start_url` / `scope` / `id`), `icons/` (generated by
  `node work/tools/make-icons.mjs`), `sw.js`, `sw-files.js` (generated), `js/pwa.js` (registration, update signal, install
  prompt, `storage.persist()`).
- **Service worker:** classic script importing `sw-files.js` (`APP_FILES`, `APP_VERSION`). Cache `denotation-<version>`;
  install precaches the shell; waits for `SKIP_WAITING` from the page (the "Update available · Reload" toast, after
  flushing saves); activate deletes older `denotation-*` caches. Same-origin GETs are stale-while-revalidate,
  navigations map to `index.html`, cross-origin and non-GET requests are never cached.
- **Versioning:** `APP_VERSION` hashes the listed files. **Run `node work/tools/gen-sw-files.mjs` whenever a file under
  `source/app/` is added, removed or renamed** (`work/test/pwa.test.js` fails otherwise). CI regenerates it on deploy.
  Dev opt-out: `localStorage["denotion:sw"] = "off"`.
- **Name:** the app shows "Denotation"; storage keys keep the old `denotion:` prefix, and import accepts both names.

## 3. Layout

```
source/app/
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
    typespec.js         type text for Custom (JSON) columns: parse/format/validate/clamp/summary/paths (pure)
    columns.js          column groups, column display, columns-as-JSON (pure)
    dbviews.js          filters, sorts, groups, chart/layout helpers (pure)
    formula.js          Excel-like formula engine             (pure)
    pivot.js            pivot tables                           (pure)
    permissions.js      AI access rules: yes/no/ignore per action, nearest ancestor wins (pure; also imported by Node)
    preview.js          record preview: key matching, preset/config resolution (pure)
    csv.js              CSV parse/serialise                    (pure)
    prefs.js            appearance preferences and tokens      (pure)
    ids.js              id generation
    pageProps.js        page properties: clean, convert, text, row <-> props, front matter (pure)
    autoCallouts.js     automatic-callout rules: clean, match, nearest set (pure)
    blocks/             block model, markdown, inline formatting, block catalogue, callout presets (pure)
    icons/              ico(name) helper + Lucide data
    ui/                 rendering: sidebar, pages, block editor, database views, dialogs, settings
source/mcp/            in-house MCP server for AI assistants (Node built-ins only, not served by the app)
work/                  development only; the app and the MCP server work without it
  test/                unit tests (node:test), e2e/ browser tests, fixtures/
  tools/               gen-sw-files.mjs, make-icons.mjs
  ticket/              open questions and plans
  design/              design spec and live style guide
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
  remove(collection, id)    -> Promise<void>,
  setMany?(collection, records) -> Promise<void> }  // optional; each record by `id`; same result as awaiting `set` for each
```

- `config.adapter: "auto"` uses `artifact-db` inside a Claude artifact, else `local`, else `memory` (with a note in the sidebar footer).
- `local` keys look like `denotion:<collection>:<id>`.
- `local` caches records in memory by storage key (`{ raw, text, dbId }`); every read compares the stored string, so
  changes from any source are seen. Readers always get a fresh `JSON.parse` copy. Decrypted plaintext is cached only while
  unlocked and dropped on any keyring key change (lock / unlock / adopt) or `dropCache()`. Per-collection key lists and a
  `dbId → keys` row index follow the adapter's own writes and are rebuilt on `storage` events or key-count drift. Writes
  to one key land in call order, even with encryption. `store.js` `setManyIn` falls back to a loop of `set`;
  `workspace.js` uses it via `createRows` / `saveRows` (one change notification per batch; `createdAt` strictly increasing).
- Collections: `pages` and `rows`. Every record carries `updatedAt` or `createdAt`.
- Keep each record under ~250 KB. Images are embedded as data URLs and shrunk to about 150 KB.
- Preferences live in `localStorage["denotion:prefs"]`.
- **Lock:** `js/lock.js` (pure; PBKDF2-SHA256, 600k iterations, 16-byte salt, constant-time compare) stores
  `denotion:pin` `{ v, length, salt, iterations, hash }`, `denotion:lock-idle` (minutes) in localStorage. `app.js main()` first finishes a pending reset
  (`sessionStorage["denotation:reset-pending"]`), then, with a PIN, awaits the lock screen (`ui/lock.js`) before
  `createStore`. Locking flushes persistence and the store, empties `#sidebar` / `#main`, sets `body.is-locked` and
  `#app[inert]`; `route()` / `drawSidebar()` do nothing while locked. `onUnlock(fn)` hands listeners the verified PIN
  (for the encryption key); it is never stored. Reset (`ui/security.js`) removes `denotion*` / `denotation*` localStorage
  keys, sessionStorage and IndexedDB `denotation`, then reloads. After a wrong PIN every prompt blocks for a fixed 3 s (`WRONG_WAIT_MS`, in memory);
  `denotion:pin-attempts` is legacy and only removed.
- **Encryption:** `js/crypto.js`: a random AES-256-GCM data key, wrapped by a PIN key (PBKDF2-SHA256 600k, 16-byte salt)
  and by a recovery key (160 bits, base32, HKDF); optional kept recovery key encrypted with the data key. Key file
  `keys.json` in each encrypted location; this device's copy in `denotion:keys`, settings in `denotion:encryption`.
  Records become `{ "denotation-enc":1, kid, iv, ct }` (fresh IV, AAD `<collection>/<id>`). `denotation.json` gains
  `encrypted`, `keyId` and, during a job, `encryption: { state, startedAt }`; `permissions.json` stays plain. On/off is a
  resumable, read-back-verified job per location (`adapters/folder.js`); locations without the key are `locked`.
  `adapters/local.js` optionally encrypts the browser copy (`migrateBrowserCopy`). The data key lives in memory only while
  unlocked. `js/zipcrypto.js`: WinZip AES-256 (AE-2) for password ZIPs. The MCP server refuses encrypted folders.
- Export/Import (sidebar ⋯ menu) goes through `vault.js`: a JSON file, a ZIP or a folder, in **Denotation JSON**
  (`denotation.json` manifest + `pages/<id>.json` + `rows/<id>.json`, full fidelity) or **Markdown** (sibling-folder
  layout, `.csv` databases, `attachments/`, relative links; lossy). Import detects the format by the manifest.
- **Storage locations** (`adapters/locations.js`, `adapters/folder.js`, Chromium only): the `local` adapter stays the
  working cache; a location is a provider with `permission / readText / writeText / remove / list` (the folder
  provider uses File System Access; Google Drive / OneDrive will plug in as providers). Per-device config:
  `localStorage["denotion:storage-locations"]` = `[{ id, type, name, role: "main"|"backup", addedAt, lastSyncAt }]`;
  handles in IndexedDB (db `denotation`, store `handles`, key `loc:<id>`); the old single folder handle migrates to a main.
  - **Main** (zero or one): two-way. Change detection: every writer stamps `denotation.json` with `{ …, updatedAt, rev, writer }` after changing records (`bumpManifest` in `sync.js` keeps unknown fields such as `encrypted` / `keyId` and normalises the known ones; `rev` +1, `writer` a per-device id in `localStorage["denotion:device-id"]`, or `mcp-<hex>` for the MCP server); the device keeps the stamp it last synced with as `seen` on the location. **Auto** (`denotion:folder-sync` = `{ mode, pushMinutes }`, migrated from the old mode string): a full merge on connect (add / make main / permission grant / boot / switch to Auto); a check that reads only the manifest on focus / visibility and every 30 s while visible, which pulls (full merge) only when the stamp differs. One shared 30 s cooldown (`SYNC_COOLDOWN_MS`) spaces checks and covers pulls and manual Pull / Push: a focus inside the window queues one trailing check; manual calls are refused with `code: "cooldown"` and the UI shows the seconds left. Local edits are queued and pushed every `pushMinutes` (5 / 10 / 15 / 30 / 60, default and minimum 5): stamp unchanged → write just those records and bump the stamp; changed → full merge. Pending edits are pushed at once (`flush()`) on `pagehide` / `beforeunload` / hidden, on disconnect / remove / make main / switch to Manual, and before Pull / Push, without moving the interval. **Manual**: no automatic
    writes; Pull / Push mirror one side onto the other after a conflict warning; a read-only check (once per window)
    powers the footer counts. Connect, make main and permission grants run at once and start the cooldown.
  - **Backups**: copy-only. The app writes changed records, tombstones, `denotation.json` and `permissions.json` after each push / sync of the main (or on the push interval with no main), and when the page is hidden; never reads them during sync. Restore = JSON restore with fresh
    `updatedAt`.
  - **Cloud providers:** `adapters/oauth.js` handles OAuth with no third-party script. Microsoft: code + PKCE with
    rotating refresh tokens (24 h cap). Google: token response (a Web client needs a secret to redeem codes), renewed by a
    hidden `prompt=none` iframe or a one-click popup. Random `state` + pending `oauth:<state>` record (10 min), nonce/aud/iss
    checks on the Microsoft id_token, popup hand-off over a same-origin BroadcastChannel or a full-page redirect;
    `handleRedirect()` runs first in `main()`. `authedFetch` retries network errors, 408/429/5xx and Drive rate limits
    (Retry-After, ≤ 4) and renews once on 401 (else `NotAllowedError` → "needs permission"). `adapters/gdrive.js`: Drive v3,
    name→id resolution, duplicates (newest wins, older deleted), search-lag merging, deletes to Drive trash.
    `adapters/onedrive.js`: Graph `approot:/<folder>/<path>:`, If-Match on `denotation.json` / `keys.json` (a manifest
    conflict rewrites ours with `rev` past both). A location's handle is a descriptor `{ cloud, v, tokenKey, folder,
    space?, account }` at `loc:<id>`; its token is at `tok:<provider>:<hex>` in the same `handles` store and is deleted
    with the location. Files over 4 MB are refused with a warning (`onCloudWarning`). Config:
    `config.oauth.{google,microsoft}.clientId`, optional `redirectUri`. Tests: fakes in `work/test/fixtures/cloud-fakes.js`,
    browser test `work/test/e2e/cloud.cjs`.
- **`sync.js`** (pure): `planSync({ local, remote, localTombstones, remoteTombstones, direction: "merge"|"push"|"pull" })`
  returns `{ toLocal, toRemote, deleteLocal, deleteRemote, writeTombstones, removeTombstones, conflicts: { newerRemote,
  olderRemote } }`; `applyPlan(plan, io)` applies it. Merge is per-record last-write-wins on `updatedAt` (fallback
  `createdAt`); a tombstone wins when `deletedAt >= stamp`, a later edit resurrects. Tombstones live in
  `tombstones/<id>.json` (`{ id, collection, deletedAt }`) and are pruned after 90 days; legacy `rows/.deleted.json`
  is read only. `saveRow` stamps `updatedAt`.

## 6. AI access (MCP)

`source/mcp/denotation-mcp.mjs` speaks MCP (JSON-RPC 2.0 over stdio) and works directly on a connected folder (or an
extracted Denotation JSON export with `--read-only`). Tools: `list_pages`, `read_page`, `search`, `create_page`,
`update_page`, `delete_page`, `add_row`, `update_row`, `delete_row`. Every call re-reads `permissions.json` (written by
the app from **AI access** settings; the server never writes it) and checks it with `source/app/js/permissions.js`. The
server writes only `pages/`, `rows/` and delete markers, via temp file + rename, never follows symlinks, and hides
unreadable titles. The app keeps a browser copy of the permissions in `localStorage["denotion:ai-permissions"]`.
`list_pages` and `search` take `includeArchived` (default false); results carry `archived: true` / `template: true`,
and search also matches page property values. Details: `source/mcp/README.md`.

## 7. Data model

- **Page types:** `repo` (top-level group), `doc` (blocks), `database` (columns + rows + views; `sourceId` makes it a linked view of another database), `sync` (synced block source).
- **Rows** belong to a database, hold `values[colId]`, and have their own `blocks`, so each row is also a page. Formula columns cache their result in `values[colId]`; `applyFormulas` recomputes them.
- **Record preview block** (`type: "preview"`): `{ dbId, keys, presetId, config, snapshot }`. Database pages may carry
  `primaryKey: <colId>` (default first column) and `previewPresets: [{ id, name, layout, columns }]`. Resolution:
  preset → snapshot (preset deleted) → own config → default.
- **Inline tokens** live in a block's `text`: `{{value:<dbId>|<key>|<colId>}}` and `{{date:YYYY-MM-DD}}` (args escape
  `\`, `|`, `}` with a backslash; invalid tokens stay literal). `blocks/inline.js` parses them to
  `{t:"inline", kind, args}`; `preview.js` `resolveValue(db, rows, key, colId)` does the primary-key lookup;
  `ui/inlineChips.js` renders chips and the picker. Markdown export takes `ctx.inline(node)` (fallback: ISO date / key).
  Catalogue entries with `inline` insert tokens instead of blocks.
- **More token kinds:** `{{const:id}}`, `{{page:id}}`, `{{status:id}}`, `{{check:0|1}}` and `{{= expr}}` (one argument up to
  `}}`; escape `\` and `}`). `replaceNthToken` rewrites one token (checkbox/status clicks). `stripInline(s, resolve?)`.
- **Links and embeds (core, `js/links.js`, pure):** stored by id as tokens `{{link:<pageId>}}`,
  `{{xlink:<pageId>}}` (hidden in the graph), `{{embed:<pageId>|h|<headingId>}}`, `{{embed:<pageId>|b|<id>,…}}` (≤ 12
  blocks). Typed `[[Title]]`, `x[[Title]]`, `![[Title]]` (= link), `![[Title][Heading]]`, `![[Title](blocks)]` convert via
  `parseWikiSyntax`; `toWikiSyntax` shows them back. `extractLinks(page)` feeds the graph (also counts `#page-` links and
  page chips); `resolveEmbed`, `detectCycle` / `embedChain` / `embedCycleFrom` handle embeds and loops; `exportCtx` for
  Markdown export.
- **Constants and statuses** live on the repository page: `constants: [{ id, name, type, value, format? }]`,
  `statuses: [{ id, label, hue }]` (pure helpers in `constants.js`; dialog `ui/repoSettings.js`; chips repaint on
  `denotion:chip-constants`). Formulas accept bare constant names and `CONST(name)`; inline formulas also get
  3-argument `VALUE(db,key,col)` and `PRESET(name,key)`. `applyFormulas` resolves constants through
  `setConstantsProvider` (installed by `installFormulaConstants(env)` in `app.js`); `evalExpression` serves inline formulas.
- **Chip presets:** `chipPresets: [{ id, name, colId, key? }]` on the data database page (`cleanChipPresets` in `preview.js`).
  Token `{{preset:<presetId>}}` or `{{preset:<presetId>|<key>}}`; resolved by `findChipPreset` → `resolvePreset` (reuses
  `resolveValue`). Slash entries are built per open by `presetEntries(...)`, not in `CATALOG`. Chips refresh on the
  `denotion:chip-presets` document event. Export: value → key → preset name.
- **Sizes** (`js/sizes.js`, pure): px / em / rem only, bare number = px. `parseSize`, `formatSize`, `clampSize`,
  `resolveSize(value, constants, range)` → `{ css, reason }` (number, size string, `{ const: id }` or constant name),
  `rowHeightInfo` / `rowHeightAttrs`; ranges `SIZE_RANGES` (image 8–4000, column 40–1600, row 20–800 px). Table block:
  `headerRow` (was `header`), `headerCol`, `colWidths`, `rowHeights`; image: `width`, `height`, `align`. UI:
  `ui/tableBlock.js`, `ui/imageBlock.js`, `ui/sizing.js`, `ui/imageUtil.js`. Inline image `{{img:<src>|<w>|<h>|<alt>}}`
  (`ui/plugins/images.js`; tokens up to `IMG_TOKEN_MAX`). Database views: `view.rowHeight` (`compact` | `tall` | size),
  applied as `rh-*` class / `--db-rh` (CSS in `css/sizing.css`).
- **Terms:** `repo.terms: [{ id, text, definition?, category?, subcategory?, hue?, icon?, parentId? }]` and
  `repo.termCategories: [{ name, hue?, icon? }]` on the repository page (limits: 500 terms, text 80, definition 500,
  category 40). Token `{{term:<id>}}`. Pure logic (clean/validate, one-level branches, inheritance own → parent →
  category default, tree order, filtering, usage counting, delete keeping or deleting branches) in `js/terms.js`. UI:
  `ui/plugins/terms.js` (chip kind via `registerChipKind`, `/Term` entry and picker), `ui/termsUi.js` (event
  `denotion:chip-terms`, chip, shared `role="tooltip"` card, `termMentionItems` for `@`), `ui/termsPanel.js` (Terms tab
  in `ui/repoSettings.js`), `css/terms.css`. Export text is `**term**`.
- **Plug-in points:** feature modules in `ui/plugins/*.js` (imported by `app.js`) register chip kinds with
  `registerChipKind(kind, { render, text?, pick? })` (`ui/inlineChips.js`), block bodies with
  `registerBlockType(type, fn)` (`ui/blockTypes.js`) and slash entries by pushing onto `CATALOG`; each has its own
  stylesheet (`css/graph.css`, `css/sizing.css`, `css/terms.css`).
- **Block colours:** `block.color` = hue (0–330, step 30) or absent; `block.bg` = hue, `"grey"` or absent. `normColor` /
  `normBg` in `blocks/model.js` map legacy names to the nearest hue. CSS: `.has-color` / `.has-bg` / `.bg-grey` with inline
  `--blk-h` / `--blk-bg-h`; lightness and chroma per mode via `--blk-fg` / `--blk-tint` / `--blk-grey`.
- **Custom (JSON) columns:** `{ type: "json", typeText }`; any JSON value, never dropped; `typespec.validate` returns
  `[{ path, message }]`. Filter rules and sorts may carry `path` (`stats.hp`).
- **Column groups:** `columnGroups: [{ id, label, colIds, parentId? }]` on the database (two levels; `applyGroups`
  cleans them and keeps each group's columns adjacent, title column first). UI in `ui/dbGroups.js`.
- **Column display:** `col.display` = `wrap` | `marquee` | `obfuscate` | `hide` (absent = clip); views may have
  `display: { colId: mode }` and `collapsedGroups: [id]`. `resolveDisplay`: view override > legacy `wrap` / `wrapAll` >
  column. In table/sheet, `a.cols` may include collapsed-group stub columns (`col.stub`, id `group:<gid>`); use
  `a.realCols` for real ones.
- **View block** (`ui/viewBlock.js`, type `dbview`): `{ sourceId, viewId?, view? }`, rendered by `renderDatabase(root, ws,
  link, { embed: { viewId?, save?, readOnly? } })`. The body is a height-capped scroller marked `data-vscroll`, used by
  `bigLists.js` for windowing. It re-renders on `ws.onDataChange` except for its own writes.
- **Data sources** (`js/sources.js`, pure): `page.dataSource` on databases; table blocks with `dataSource`,
  `sourceName`, `sourceKey?` become read-only virtual databases with id `tbl-<blockId>` (text columns `c0…`, rows
  `tbl-<blockId>:r<n>`), never written to the store. `sourceList(pages, { tables, linked })` orders every picker
  (data sources, other databases, tables). `ws.createDatabaseFromTable(...)` converts a table.
- **Page properties:** `page.props: [{ id, name, type: text|number|date|select|multi|checkbox|url|page, value, options? }]`
  (max 50; `cleanProps`). Docs and databases only; rows use columns. `page.propsCollapsed` folds the panel
  (`ui/propsPanel.js`). Searched by `ws.search` and the MCP `search`. Markdown front matter: `frontMatter` /
  `propsFromFrontMatter`.
- **Templates:** `page.template: true`, `page.templateFor: <dbId>` for row templates. `inTemplate(pages, p)` hides
  templates and their children from the tree. `ws.createFromTemplate(id, parentId)` clones blocks (new ids), props and
  `autoCallouts` (new rule ids, `pinnedRules` remapped). `ws.createRowFromTemplate(db, id)` maps props to columns by name.
- **Callout presets:** `CALLOUT_PRESETS = [{ id, label, icon, color, bg }]` in `blocks/callout-presets.js` (data only).
  Block `preset: <id>` plus overrides `custom: { icon?, color?, bg? }` (`null` = explicitly none). `calloutLook(b)` in
  `blocks/callout.js` resolves the look; no preset = legacy `icon`/`color`/`bg`.
- **Automatic callouts:** `autoCallouts: [{ id, when: { prop, op: is|is not|empty|not empty|contains|before|after, value },
  preset, text }]` on pages, templates, databases and rows (max 30). Chain, nearest first: page → ancestors; row → its
  database → the database's ancestors. `nearestRules` picks the first non-empty set; `matchingCallouts` returns its
  matches. Rendered by `ui/autoCalloutsUi.js`, never stored. `pinnedRules: [ruleId]` hides rules pinned as blocks.
- **Row pages:** `page.rowPages` on databases (`false` for new ones; missing = on). `ws.setRowPages(dbId, on, { bodies:
  "archive"|"trash" })` returns `{ needs }` when written bodies exist and no choice is given. `ws.rowBodyToPage` turns a
  body into a doc with the row's values as props and `archivedFrom: { dbId, rowId, dbTitle }`. When off, `#row-<id>`
  renders a read-only property view.
- **Archive:** `page.archivedAt`; route `#archive`. `isArchived(pages, p)` walks ancestors like `isTrashed`; `isHidden` =
  trashed or archived. Use `isHidden` for every listing (sidebar, `sources.js`, chips, view blocks, vault Markdown, Move
  to). `ws.archivePage` / `unarchivePage` / `listArchive` / `archiveToTrash`; `search(q, limit, { includeArchived })`.
  Archived databases render with `renderDatabase(..., { frozen: true })`. Markdown export skips archived pages; JSON keeps them.
- **Links and graph (UI):** link tokens are stored by id. `ws.links` (`graph/workspaceLinks.js`) keeps one link index per
  workspace: workspace writes re-index the saved record, `listPages` re-checks pages by `updatedAt`, rows are indexed
  lazily (`ensureLinkRows`, `invalidateRows` after a pull). `graphNodes(pages, rows)` builds node records and
  `repoRules(repos)` scopes each repository's `graphRules` (`[{ when: [{ prop | field, op, value }], icon?, color?, size? }]`,
  ≤ 40; `graphSize: "fixed"` optional) to its pages; `page.graph = { icon?, color?, size? }`. UI: `ui/graphView.js`
  (route `#graph[-repoId]`, local panel, `graph` block with `b.graph = { scope, depth, mode }`, appearance and rules
  dialogs), `ui/linkChips.js`, `ui/linkPicker.js`, `ui/backlinks.js`. Positions: memory plus localStorage
  `denotation-graph-pos` (6 graphs, 3000 positions). Tests: `work/test/graph-links.test.js`, `work/test/links.test.js`,
  `work/test/e2e/links.cjs`, `work/test/e2e/graph.cjs`.
- **Graph engine** (`js/graph/`): `model.js` (link index + `buildGraph`: hidden links draw no edge,
  mutual links are two-way, rows only when their database is included or a page links them), `style.js` (explicit
  per-page `graph` settings, then the first matching rule, then size from link count), `layout.js` (Barnes–Hut force
  layout, deterministic per seed, warm start from cached positions) run by `runner.js` in `layout.worker.js` with a
  main-thread fallback, `render.js` (canvas, draws on change only, level of detail, grid hit-testing), `list.js`
  (accessible list), `index.js` (`createGraphView`). Tests: `work/test/graph.test.js`, `work/test/graph-bench.test.js`
  (`GRAPH_BENCH=full` for 5000 nodes), `PORT=8094 node work/test/e2e/graph.cjs` (`GRAPH_SIZES=1000,5000`, `SHOTS=dir`).
- **Popovers** close on route change: `closePopovers()` in `ui/popover.js` (also fires `denotation:close-popovers`).
- **Views:** table, sheet, board, list, gallery, calendar, feed, chart, dashboard, each with its own filters, sorts, groups and layout.

## 8. UI conventions

- `h(tag, props, ...children)` in `ui/dom.js` builds DOM. `replaceChildren` turns `null` into the text "null", so `.filter(Boolean)` child lists.
- **Big lists** (`ui/bigLists.js`): tables and sheets over 120 rows are windowed (only rows near the viewport are in the
  DOM, spacer `tr.vspacer` rows keep the height, scroller is `#main`); board/list/gallery/feed cards are drawn in chunks.
  Use `tbody tr:not(.vspacer)` in selectors. `dbView` batches edits with `setCell(row, col, raw, { defer })` +
  `commitRows(list)`. The sidebar skips rebuilds when its page signature is unchanged. `isTrashed` / `ancestors` cache an
  id index per pages array.
- Never use native `alert` / `confirm` / `prompt`: use `ui/dialogs.js` and `ui/modal.js`.
- Icons: `ico(name)` from `js/icons/index.js`. Add new icons to `lucide-data.js`; never load them from a CDN.
- Sidebar rows have no inline buttons: right-click, long-press or Shift+F10 opens the page menu.
- Context menus: `ui/contextMenu.js` `bindContextMenu(el, getItems)` (right-click, 520 ms long-press, Shift+F10 / Menu key;
  native menu kept on inputs, links and selected text). Database row menus are in `ui/dbMenus.js`, pure helpers in `dbMenuLogic.js`.
- **Block menu** (`ui/blockMenu.js`, `ui/blockExtras.js`): `openBlockMenu(anchor, b, inst, a, {target})` builds the generic
  items plus whatever the block registered with `setBlockMenu(b, ({target}) => items)` (a `WeakMap` keyed by the block,
  re-registered on each redraw). `target` is the right-clicked element (e.g. a `.tbl-cell` with `data-r` / `data-c`). Items
  flagged `viewOnly` also show on locked pages. Block settings go through `setBlockMenu`, never an in-flow bar.
- **Selection and handle:** `blockEditor.js` keeps `selId` (set on `focusin` / `pointerdown`, cleared by a press outside);
  the row gets `.sel`. `.gutter` shows for `.blk-row.sel` and, under `(hover:hover)`, on hover; geometry comes from
  `--h-left` / `--h-w` per container. `.doc-body` has a 28px lane on both sides so text margins match.
  `wireBlockContextMenu` handles contextmenu, Shift+F10 and a 520 ms long-press; `.tbl-cell`, `.bm-card`, `.page-link` and an
  unfocused code textarea open the block menu even though they are inputs or links.
- Pure table helpers in `blocks/model.js` (`tableInsertRow/DeleteRow/InsertCol/DeleteCol`) keep `colWidths`, `rowHeights`
  and `sourceKey` aligned.
- Escape all user, CSV, markdown and imported content before it reaches the DOM. No `eval` or `new Function` outside the sandboxed formula engine.

## 9. Theme

Colour tokens are CSS custom properties on `:root`, redefined for dark mode. The accent is one of 24 OKLCH hues (0–345° in 15° steps, chroma 0.16) or grey, stored as `prefs.accent` (`"random"`, `"grey"` or the hue). `"random"`, the default, picks a new hue on each load and never grey. Grey is dark grey in light mode and light grey in dark mode. See `CLAUDE.md` → Theme for the exact formulas.

## 10. Roadmap

1. GitHub Pages deploy and installable app (manifest, icons, service worker, install button).
2. IndexedDB cache with migration from localStorage.
3. Google Drive and OneDrive as storage-location providers (reusing `sync.js`), browser-only (no backend).

The details are in `CLAUDE.md`.
