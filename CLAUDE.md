# Denotation

Self-use Notion/Obsidian-style workspace. Plain HTML/CSS/JS, runs entirely in the browser, stores everything locally.
It started as a Claude Artifact ("Denotion"); this repo starts fresh from that code. Goal: host on GitHub Pages as an
installable PWA with optional Google Drive / OneDrive sync. Sibling project and practice reference: `nin827/studyblock`.

> AI-coded with human supervision.

## Hard rules

- **Folders:** `source/` is everything the product needs (`source/app/` = the served app, `source/mcp/` = the AI
  connector). `work/` is development only (`work/test`, `work/tools`, `work/ticket`, `work/design`). Deleting `work/`
  must leave the app and connector fully working: nothing in `source/` may import or read from `work/`.
- **No packages, no build step.** Native ES modules only. Build everything in house (markdown, CSV, formulas, charts,
  sync, UI). The only third-party code allowed is **Lucide icons** (a trimmed set in `source/app/js/icons/lucide-data.js`) and
  **KaTeX** (math rendering, MIT; vendored with its fonts and licence when the math feature lands, ticket 022).
  Nothing loads from a CDN, so the app works offline. `npm` is just a script runner (`npm start`, `npm test`), with no dependencies.
  Dev-only exception: Playwright (preinstalled) for the browser smoke test.
- **Served over HTTP:** `npm start` (`python3 -m http.server 8080 -d source/app`, binds 127.0.0.1). Port 8080 is the
  owner's real data; agents test on **8090–8099**, never 8080.
- After adding, removing or renaming any file under `source/app/`, run `node work/tools/gen-sw-files.mjs` (service-worker
  precache list; `work/test/pwa.test.js` checks it).
- Every path is relative (GitHub Pages serves under `/<repo>/`). No leading `/` in fetches, imports or links.
- No native `alert` / `confirm` / `prompt` (use `ui/dialogs.js`, `ui/modal.js`).
- Never put personal details (names, emails) in project files.
- Fonts are system stacks or vendored open-source (SIL OFL) files in `source/app/fonts/`. Never load fonts from a CDN.

## Safety

- **Code:** no `eval` / `new Function` (outside the existing sandboxed formula engine) and no `innerHTML` with unescaped
  text. Escape all user, markdown, CSV and imported content. Links allow only `http:`, `https:`, `mailto:` and relative
  URLs. Imported files are validated as data and never executed.
- **Sync / sign-in:** never load third-party scripts (any script on the page can read tokens). OAuth client IDs are public
  config in `js/config.js`; tokens live only in IndexedDB.
- **Commands:** no `rm -rf` outside scratch/build output, no `git reset --hard`, no force-push, no installers or downloads
  without the owner's OK.

## Workflow

- **Main chat orchestrates; agents code.** The main session plans, writes narrow briefs (goal, files owned, spec, how to
  verify), reviews diffs, runs tests and verifies in the browser. Implementation goes to subagents. Parallel agents must
  never own the same files.
- **Agent models, by task:**
  - **Sonnet:** most coding work and basic research (the default).
  - **Opus:** critical or sensitive code (storage, sync, auth, data migration), sub-orchestration, deeper research.
  - **Haiku:** data retrieval, lookups and simple queries only.
- **Owner preferences:** try the simple solution first and go more complex only if asked. Keep explanations short.
  Split long output into several messages. If the owner's `budget` skill is active, plan on Opus, implement on Sonnet,
  and pause to let them switch models.
- **Don't block on questions.** Put open questions in `work/ticket/NNN-slug.md` (see `work/ticket/README.md`), carry on with a
  sensible default, and walk through them when the owner says "clear tickets".
- **Commits:** group related, tested work into one commit (e.g. a feature with its docs, tests and follow-up fixes)
  instead of many small ones, so history stays readable. Push after each. Never commit files an agent still owns.
- **Delivery** is the repo and GitHub Pages. Don't publish Claude artifacts.

## Docs

- `README.md`: an introduction for newcomers (what it is, what it can do, getting started, links). Short and friendly, not a manual.
- `README_INSTRUCTION.md`: the full user guide. Update it whenever user-facing behaviour changes.
- `README_TECHNICAL.md`: the technical manual (architecture, storage interface, data model, testing).
- `CLAUDE.md`: the developer and agent spec.
- The main session owns all docs; agents report doc changes instead of editing them, unless a brief assigns a doc.

## Testing

```bash
npm test                     # node --test work/test/*.test.js  (built-in runner only)
node work/test/e2e/smoke.cjs      # Playwright smoke test on port 8099
```
- Add `node:test` unit tests (seeded fuzz where useful) for pure logic modules as they're touched: `schema`, `dbviews`,
  `formula`, `pivot`, `csv`, `prefs`, `blocks/*`, `workspace` (with the `memory` adapter).
- Keep the smoke test green and extend it for new UI flows.

## Architecture

Full details in `README_TECHNICAL.md`. In short:
- `source/app/index.html`, `css/style.css`, `js/app.js` (hash routing `#page-<id>`).
- Storage behind `js/store.js` with adapters in `js/adapters/` (`local`, `memory`, `artifact-db`, `firebase` stub), all
  with the interface `list/get/set/remove(collection, id, data)`. Collections `pages` and `rows`; every record carries
  `updatedAt` or `createdAt`. Prefs in `localStorage["denotion:prefs"]`.
- Storage locations: `adapters/locations.js` (provider interface, config) + `adapters/folder.js` (IO, main/backups,
  auto/manual) + pure `js/sync.js` (merge/push/pull planner with tombstones). Google Drive / OneDrive must plug in as
  providers and reuse `sync.js`.
- `js/workspace.js` holds all data operations. `js/ui/*` renders. `h(tag, props, ...children)` is the DOM helper;
  `replaceChildren` stringifies `null`, so `.filter(Boolean)`.
- Keep each record under ~250 KB (also matters for sync). Rows cache formula results in `row.values[colId]`; `applyFormulas` recomputes them.
- AI access: `source/mcp/` is a Node-only MCP server (built-ins only, no dependencies). `js/permissions.js` must stay
  pure because Node imports it. The server never writes `permissions.json`.
- Sidebar rows have no buttons: right-click, long-press or Shift+F10 opens the page menu. Long titles roll as a marquee.

## Theme (reference: studyblock `js/lib/theme.js`, `css/style.css`)

- **Accent:** one of 24 OKLCH hues (0–345° in 15° steps, chroma 0.16) or grey, applied as `--accent-h` / `--accent-c`
  on `<html>`. CSS derives:
  - Light: accent `oklch(0.50 C H)`, soft `oklch(0.95 C·0.22 H)`, ink `oklch(0.40 C·0.875 H)`, text on accent white.
  - Dark: accent `oklch(0.72 C H)`, soft `oklch(0.30 C·0.45 H)`, ink `oklch(0.85 C·0.6 H)`, text on accent near-black.
  - **Grey** (chroma 0): **dark grey in light mode, light grey in dark mode**.
- **Default is Random:** a random hue from the 24 on each load, never grey. Stored as `prefs.accent` =
  `"random" | "grey" | <hue>`; invalid or legacy hex values become `"random"`.
- **One theme, four value modes** (`prefs.mode`, applied as `<html data-mode>`): **neutral** (default, soft grey, counts
  as light for the accent), **light**, **dark**, **variable** (light 07:00–19:00 local time, dark otherwise). No colour
  presets and no custom background/text colours.
- **Fonts:** a short *Recommended* list (system sans (default), serif and mono, plus vendored Noto Sans / Noto Serif /
  Noto Sans Mono) and an *On this device* list from `queryLocalFonts()` where supported (otherwise a font-name field).
  Device fonts are never presented as recommendations.
- **Design:** clean and minimal. The design spec and live style guide are in `work/design/` (`work/design/README.md`,
  `work/design/index.html`); keep them in sync with `css/style.css`.
- Correct, selected and error states show an icon or label, never colour alone. Respect `prefers-reduced-motion`.
- Mobile-first: works from 360px wide, no horizontal page scroll, respects `env(safe-area-inset-*)`, inputs ≥ 16px on
  phones, no hover-only affordances.

## Roadmap: GitHub Pages + PWA + local files + cloud sync (feasible, no backend)

1. **Deploy + PWA (done).** GitHub Actions workflow publishing `source/app/` to Pages, plus `.nojekyll`. `manifest.webmanifest`
   (relative `start_url`/`scope` `./`), icons generated in house, `sw.js` (precache app shell, versioned
   `CACHE_VERSION`, stale-while-revalidate for same-origin GETs, never cache cross-origin, delete old caches on
   activate). "Update available · Reload" toast. Install button in Settings (`beforeinstallprompt`; iOS shows
   "Share → Add to Home Screen"). Call `navigator.storage.persist()`.
2. **Local storage upgrade.** `js/adapters/indexeddb.js` (same interface) as the working cache, with a one-time
   migration from localStorage. (Folder locations, main + backups, auto/manual sync and tombstones are done.)
3. **Google Drive sync (built, untested against the real service; see ticket 020).** Hand-written OAuth token flow (no GIS script), scope `drive.appdata` (or `drive.file`), Web OAuth
   client with the Pages origin. Tokens last ~1 h with no refresh token, so re-authorise quietly. Check whether the scope
   needs Google verification. GIS is a Google-hosted script: confirm with the owner, or use a hand-written OAuth redirect flow.
4. **OneDrive sync (built, untested against the real service).** Microsoft identity platform auth-code + PKCE (SPA, redirect = Pages URL), scope
   `Files.ReadWrite.AppFolder`, Graph over CORS. Refresh tokens last ~24 h.
5. **Sync design** (implemented in `js/sync.js` for folders): per-record last-write-wins on `updatedAt`, tombstones,
   main + copy-only backups, auto/manual with Pull/Push warnings, status in the sidebar footer. Still to do: chunk or
   skip oversized rows for cloud providers. Client IDs are public: the owner registers them and each user signs in with their own account.
   Browser limits: localStorage ~5 MB; iOS Safari clears data after ~7 days unless installed; Safari/Firefox have no folder picker.

The owner needs to create the Google OAuth client ID and the Azure app registration; ask for the IDs (they go in `js/config.js`).

## Ideas

CSV import preview with type fixing; optimistic new-row creation; pivot filters; formula bar in sheet cells; timeline
view; status / multi-select / URL properties.
