# 013: Database views in pages, and data sources

Status: queued (with tickets 010–012, after the performance pass)
Raised: 2026-11-27

Request: "like Notion, add support for view to a database, as well as marking a table as data source".

Today: databases have several views (tabs). Linked views exist only as separate sidebar items (New → Database view of…).
The `/database` block only links to a sub-page.

Plan:
- **View block** (`/view`, "Database view"): embeds a live view of a database inside any page, like a Notion
  linked/inline view. Pick the source, then a layout (table, sheet, board, list, gallery, calendar, chart…). The block
  has its own tabs, filters, sorts, groups and column display, stored in the block. Rows edited here update the
  source. The block can show one of the source's own views or a custom one.
- **Mark as data source** (database page menu → **Data source**, on/off):
  - Marked databases are listed first in every source picker: view block, linked views, value/preset chips,
    record preview.
  - They stay in the page tree, with a data-source badge.
  - A data source can be referenced but stays editable as usual.
- **Plain table blocks** (`/table`) can also be marked as a data source: the first row becomes the column names, and
  the block gets a name and a key column. It then works in views, chips and previews like a small read-only database,
  with a **Convert to database** action.

## Owner decision
Both databases and plain table blocks can be marked as data sources. Marked databases stay in the page tree with a badge.
