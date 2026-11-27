# Handoff

State of the project for the next session. Read `CLAUDE.md` first (rules, workflow), then this file, then the open
tickets in `work/ticket/`.

## Where things are

- Version **0.1** (`config.version`, `package.json`). `main` = the work branch, deployed to GitHub Pages from `main`
  (the root `index.html` forwards to `source/app/`).
- Tests: `npm test` (unit, built-in runner, ~640 tests incl. seeded fuzz), browser e2e in `work/test/e2e/*.cjs`
  (Playwright, `PORT=809x`, never 8080). Run any e2e with the CSP watcher:
  `node -r ./work/test/e2e/csp-watch.cjs work/test/e2e/<test>.cjs`.
- Docs: `README_INSTRUCTION.md` (user guide), `README_TECHNICAL.md` (architecture), `CHANGELOG.md`.

## Built recently (newest first)

- PIN-locked sign-in tokens, Content-Security-Policy meta; cross-tab lock, linked-image setting, anchored editors and
  the `-x^2` maths rule (see "Last batch" below).
- Ticket 016/020 follow-ups: background formula refresh after constant changes, search sees chip text, stable table
  column ids, sticky sheet group rows, error-location retry, duplicate cloud folder refused.
- Ticket 022: math (KaTeX vendored in `source/app/vendor/katex`), function graphs (`plot`), inline charts (`chart`).
- Ticket 021: flowchart block (`flow`) with fill, label nudging, grid routing, box links (`#page-<id>~<node>`).
- Fuzz suite (`work/test/fuzz-*.test.js`) and the fixes it found; no known-bug todos remain.
- Block settings live in the right-click / long-press block menu (`setBlockMenu`); handle only on the selected line.

## Plug-in points (add features without touching shared files)

- `registerBlockType(type, fn)` (`ui/blockTypes.js`), `registerChipKind(kind, {render, text?, pick?, action?})`
  (`ui/inlineChips.js`), slash entries pushed onto `CATALOG` (`blocks/catalog.js`), block settings via
  `setBlockMenu(b, ({target}) => items)` (`ui/blockExtras.js`). Plugins in `ui/plugins/*.js`, imported by `app.js`.
- A new block type must also be added to `BLOCK_TYPES` in `blocks/model.js`; a new token kind to `TOKEN_KINDS` +
  `checkToken` in `blocks/inline.js`; Markdown via a fenced block in `blocks/markdown.js`.
- After adding files under `source/app/`: `node work/tools/gen-sw-files.mjs`.

## Open / waiting on the owner

- **020 cloud:** needs the Google OAuth client ID and Azure app ID (step-by-step in the ticket). Then test with real
  accounts and confirm CSP hosts (OneDrive may need `*.livefilestore.com` / `*.storage.live.com`).
- **005 APK:** waiting until the owner tries the installed web app on Android.
- **021 flowchart:** no link-picker option for boxes yet (needs a token change in `blocks/inline.js`).

## Known limits / ideas

- Strict styles (dropping `'unsafe-inline'` from `style-src`) needs `h()` to set styles via CSSOM and flowBlock SVG
  styles moved.
- `content-visibility` on blocks was measured and rejected (see README_TECHNICAL); a windowed block list would be the
  next step for very long pages.
- Ideas list at the end of `CLAUDE.md`.

## Last batch

(Filled in when the last three agents land.)
