# Changelog

## 0.1 (2026-11-27)

Added: inline math and math blocks (KaTeX, vendored for offline use) with an editor (live preview, symbol palette)
and Markdown `$` / `$$` export and import.

Added: Flowchart block (`/flowchart`) with automatic layouts (flow, cycle, tree, row, grid), 8 shapes, colours, a
quick text syntax, an edit dialog and Markdown export/import; box Fill colour, labels kept off boxes, grid connections
routed around boxes, and links to a single box.

Fixes from the fuzz tests:
- Security: url properties drop `javascript:` links hidden with tabs or control characters; imported term colours
  can't inject CSS (terms are cleaned when read); CSV export neutralises spreadsheet formulas.
- Pages nested more than 100 levels under a trashed or archived page now count as trashed or archived; AI
  permissions apply at any depth and fail closed.
- One corrupt record no longer stops the workspace loading; corrupt or oversized ZIP entries fail cleanly; key files
  with absurd iteration counts are refused; search tolerates malformed properties.
- No more slow-downs on unmatched `*`, `_`, `**` or unterminated `{{img:`; emphasis inside inline tokens or code spans
  no longer breaks them; paragraphs starting with `#`, `-`, `1.` or `>` survive a Markdown round trip; embeds that
  fan out are capped (5 levels, 2000 expansions); odd imported blocks, graph rules and sizes no longer crash; formula
  hardening (own-key access, wildcard matching, `REPT` cap, large `MIN`/`MAX`).
- Blocks nested more than 100 levels deep move up a level instead of crashing (text and order kept).
- Sync: copies with the same stamp but different content now converge (merge picks the same winner on every
  device; Push / Pull overwrite them). CSV import keeps a carriage return inside a quoted cell.

First marked version. Highlights:
- Pages, sub-pages, repositories, blocks, Markdown shortcuts, page properties, templates, callout presets,
  automatic callouts, Archive and Trash.
- Databases with table, sheet, board, list, gallery, calendar, feed, chart and dashboard views; formulas, custom JSON
  columns, column groups and display modes, view blocks and data sources.
- Inline chips: database values, dates, presets, constants, pages, statuses, checkboxes and inline formulas.
- Storage: browser (local cache), folders (main + backups), Google Drive and OneDrive (awaiting client IDs),
  optional encryption with a PIN and recovery key, password ZIP exports.
- Installable PWA with offline use; AI access through the local MCP connector.
- Links (`[[`, hidden `x[[`), embeds (`![[`), backlinks, global/local graph and graph block.
- Terms with categories and branches; table and image sizing; inline images.
- Install app in the workspace ⋯ menu (browser dialog or how-to); the repository root forwards to the app, so
  GitHub Pages works from a branch or from the Actions workflow.
- Block settings (table, image, code, pivot, record preview, view, graph, bookmark) live in the right-click /
  long-press block menu; the ≡ handle shows only on the selected line and sits out in the margin; equal text margins.
