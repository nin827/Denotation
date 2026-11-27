# 016: Performance follow-ups (from the performance pass)

Status: done (item 1 tried and rejected)
Raised: 2026-11-27

1. CSS: `content-visibility: auto; contain-intrinsic-size: auto 28px` on `.blk-wrap` (600-block docs are now bound
   by layout; expected roughly 2× faster open).
2. `adapters/local.js` + `workspace.listPages`: cache parsed (and decrypted) records by raw string or by key + version,
   so `route()` doesn't re-parse every page on each navigation.
3. `adapters/local.js`: index row keys by `dbId`, so `listRows(dbId)` doesn't parse every row of every database.
4. `app.js`: `route()` calls `drawSidebar()` twice per navigation; drop one.
5. Saving after a `SUM(ALL(..))`-style formula change writes every row synchronously: add `store.setMany` or chunked
   deferred saves, flushed on hide like other pending saves.
6. (from constants) After a constant changes, database formula caches recompute only when that database is opened;
   the MCP server sees stale values until then. Consider recomputing affected databases in the background.
7. `pageView.js` `exportMarkdown` lookup has no `pageId`, so constants/statuses resolve via the first repository;
   add `pageId`.
8. Search (`plainText` → `stripInline` without a resolver) doesn't see constant values, page-chip titles or status labels.
9. (bug) Popovers/menus stay open after the route changes (seen: a calendar day menu still showing on a row page).
   Close open popovers on navigation.
10. Column groups: group label rows aren't sticky; freeze offsets ignore collapsed-group stubs.
11. Table data sources: column ids are positional (`c0…`), so inserting a table column shifts chips that refer to
    later columns. Consider stable column ids on table blocks.

## Done (commit "Faster local storage")
- Items 2, 3 and 5: record cache, row index by `dbId`, `setMany` / `ws.saveRows` (also used by formula recompute in
  `settle`). Also fixed: `createRow`'s `createdAt` counter wrapped after 1000 rows in one millisecond, so big CSV
  imports came back out of order.

## Done (commit "Ticket 016 follow-ups")
- Item 1, **not adopted**: `content-visibility: auto; contain-intrinsic-size: auto 28px` on `.blk-wrap` was measured with
  `work/test/e2e/blockperf.cjs` (600-block doc, headless Chromium, median of 5). Open time to first frame went from
  ~375 ms to ~600 ms (layout itself got faster, the first paint got slower), the paint containment clips the drag handle
  in the left margin (it can no longer be hit) and the drop-indicator shadow, and a smooth TOC jump to a far heading
  landed ~2700 px off because skipped blocks have estimated heights. Documents of 600 blocks open in under 0.4 s, so the
  rule is not worth its side effects. Revisit with a windowed block list if documents get much longer.
- Item 4: `route()` draws the sidebar once, after the page list reloads.
- Item 6: `formulaRefresh.js` recomputes formula caches of the repository's databases after a constants save (idle time,
  one database at a time, rows saved in chunks of 200 with `ws.saveRows`, a newer edit cancels the older run).
- Item 7: Export as Markdown passes `pageId` (a row's database id), so constants and statuses use the right repository.
- Item 8: search resolves constant values, status labels, page-chip titles and terms (`workspace.search`).
- Item 9: already fixed earlier (`closePopovers()` in `route()`, popovers, block menu, record preview and term card
  listen for it); covered by the smoke test "popover close on navigation".
- Item 10: in the sheet each header row (letters, group rows, names) sticks below the one above (`stackHeadRows`).
  `view.freeze` counts real columns, so `freezeCount` freezes a collapsed-group stub only when every column it hides is
  inside the count (collapsing a group no longer freezes extra columns). The table view's header is not sticky at all
  (the page scrolls, not the table), so there is nothing to stack there.
- Item 11: table blocks store stable `colIds` (+ counter `colSeq`) from the first column insert, delete or shrink on;
  untouched tables keep the positional `c0...` ids, so existing chips keep working. `tableInsertCol`, `tableDeleteCol`
  and `tableResize` keep ids, widths and `sourceKey` aligned; damaged `colIds` are dropped when blocks are normalised.
