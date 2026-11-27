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
