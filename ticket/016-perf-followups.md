# 016: Performance follow-ups (from the performance pass)

Status: queued
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
