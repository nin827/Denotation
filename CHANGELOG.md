# Changelog

## 0.1 (2026-11-27)

Fixes from the fuzz tests:
- Security: url properties drop `javascript:` links hidden with tabs or control characters; imported term colours
  can't inject CSS (terms are cleaned when read); CSV export neutralises spreadsheet formulas.
- Pages nested more than 100 levels under a trashed or archived page now count as trashed or archived; AI
  permissions apply at any depth and fail closed.
- One corrupt record no longer stops the workspace loading; corrupt or oversized ZIP entries fail cleanly; key files
  with absurd iteration counts are refused; search tolerates malformed properties.

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
