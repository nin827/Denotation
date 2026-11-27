# Denotation: notes for Claude Code sessions

Self-use Notion/Obsidian clone. Plain HTML + ES modules, no framework, no runtime build step.
It was developed as a published Claude Artifact ("Denotion"); this repo starts fresh from that
artifact's code. Goal now: host on GitHub Pages as an installable PWA with optional
Google Drive / OneDrive sync.

## Working with the owner
- Try the simple solution first; go more complex only if asked.
- Keep explanations short. Split long output into several messages.
- If their `budget` skill is active: plan on Opus, implement on Sonnet, pause to let them switch models.
- Do not publish artifacts any more: the repo and GitHub Pages are the delivery. `dist/` and
  `build/artifact.mjs` are only needed if the artifact is still wanted.

## Run, build, test
```bash
npm start                    # python3 -m http.server 8080 -d public
npm run build                # dist/denotion.html (artifact fragment) + dist/denotion.standalone.html
node test/e2e/smoke.cjs      # loads public/ and dist standalone, clicks around, fails on any error (port 8099)
```
`ESBUILD_PATH=<esbuild package dir> node build/artifact.mjs` uses a preinstalled esbuild when npm is offline.

Testing expectations: add `node --test` unit tests (seeded fuzz where useful) for pure logic
modules as they are touched, and keep the browser smoke test green. `js/adapters/firebase.js`
is a stub (optional adapter, not needed for the plan below).

## Architecture (public/)
- `index.html`, `css/style.css`, `js/app.js`. Routing by hash (`#page-<id>`), so no server
  rewrites on GitHub Pages; all asset paths are relative.
- Storage behind `js/store.js`, adapters in `js/adapters/`: `local` (localStorage, prefix
  `denotion`), `memory`, `artifact-db` (Claude artifact), `firebase` (stub). `js/config.js`
  picks one (`auto`: artifact-db inside an artifact, else local, else memory).
  Collections: `pages`, `rows`. Every page/row carries `updatedAt` or `createdAt`.
- `js/workspace.js`: all data operations (pages, rows, trash, duplicate, tickets, CSV import,
  export/import JSON, `onDataChange` listeners).
- Pure logic (no DOM): `schema.js`, `dbviews.js`, `formula.js`, `pivot.js`, `csv.js`, `prefs.js`, `blocks/*`.
- `js/ui/*`: rendering. `h(tag, props, ...children)` is the DOM helper; `replaceChildren`
  stringifies `null`, so always `.filter(Boolean)`.
- Page types: `repo`, `doc`, `database` (columns + rows + views; `sourceId` = linked view), `sync`.
- Views: table, sheet, board, list, gallery, calendar, feed, chart, dashboard.
- Prefs in localStorage key `denotion:prefs`.

## Decisions and gotchas
- No native `alert/confirm/prompt` (artifact sandbox blocks them): use `ui/dialogs.js`, `ui/modal.js`.
- Icons are inline SVGs from `js/icons/lucide-data.js` (trimmed Lucide set). Add icons there, not via CDN.
- Keep documents < 250 KB each (artifact DB limit; matters for sync too). Images are shrunk to ~150 KB data URLs.
- Data rows cache formula results in `row.values[colId]`; `applyFormulas` recomputes them.
- Sidebar rows have no buttons: right-click, long-press or Shift+F10 opens the page menu.
  Long titles scroll as a marquee.
- Sidebar order of the seeded demo pages varies between runs (random ids); existing behaviour.

## Next task: GitHub Pages + PWA + local files + cloud sign-in (feasible, no backend)
1. **Deploy + PWA.** Actions workflow publishing `public/` to Pages; `manifest.webmanifest`, icons,
   service worker (cache app shell, scope = repo subpath, versioned cache), install prompt in
   Settings. Check relative paths under `/<repo>/`.
2. **Local storage upgrade.** `js/adapters/indexeddb.js` (same interface as `local.js`), one-time
   migration from localStorage, `navigator.storage.persist()`. Optional File System Access adapter
   (Chromium only; folder can sit in a synced Drive/OneDrive folder), handle permission re-prompts,
   fall back to IndexedDB.
3. **Google Drive sync.** Google Identity Services token flow, scope `drive.appdata` (or
   `drive.file`), Web OAuth client with the Pages origin. ~1 h tokens, no refresh token: re-authorise
   quietly. Token only in IndexedDB. Re-check whether the narrow scope needs verification.
4. **OneDrive sync.** MS identity platform auth-code + PKCE (SPA, redirect = Pages URL), scope
   `Files.ReadWrite.AppFolder`, Graph with CORS. Refresh tokens ~24 h.
5. **Sync design.** Per-document last-write-wins on `updatedAt` with delete tombstones; chunk or
   skip oversized rows; sync status in sidebar footer. Client IDs are public (owner registers;
   each user signs in with their own account). Never load third-party scripts. Limits:
   localStorage ~5 MB; iOS Safari clears data after ~7 days unless installed; Safari/Firefox have
   no folder picker.

Owner must create the Google OAuth client ID and Azure app registration; ask for the IDs (or put
them in `js/config.js`).

## Ideas
CSV import preview with type fixing; optimistic new-row creation; pivot filters; formula bar in
sheet cells; timeline view; status/multi-select/URL properties.
