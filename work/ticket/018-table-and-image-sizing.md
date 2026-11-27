# 018: Table block sizing and headers; image sizes (number or variable)

Status: resolved (built; see commit "Table and image sizing")
Raised: 2026-11-27

## Table block (`/table`)
- **Column width** per column and **row height** per row: drag the edge, or set a value from the column/row menu
  (keyboard and touch path). Stored as `colWidths: [size|null]` and `rowHeights: [size|null]` (size = px/em/rem) (null = auto).
- **Header row / header column:** toggles in the table menu (`headerRow`, `headerCol`), rendered as `<th scope>`
  with header styling. Several header rows/cols are not planned unless asked. A table used as a data source keeps
  using its first row as column names.
- Database tables already have column widths; database row height (compact / normal / tall, or a number per view)
  is added there too for consistency.

## Images
- **Image block:** width and height (keep aspect ratio unless both are set), alignment (left / centre / right),
  plus drag handles. Values are **a number with a unit** (`320px`, `20em`, `12rem`; a bare number means px) **or a variable**: a repo constant (ticket 009), e.g.
  `{{const:id}}` or its name `photoWidth`, so changing the constant resizes every image using it.
  Stored `{ width?, height?, align? }`, each a number+unit or `{ const: <id> }`.
- **Inline image** (new chip kind): `{{img:<src>|<width>|<height>}}` inside text, sized the same way (number or
  constant name), with a picker from `/Inline image`. Same source rules as the image block (data URL shrunk to about
  150 KB, or an http(s) URL), and alt text for accessibility.
- Markdown export: `<img>`-free; writes `![alt](src)` with the size dropped (or as an HTML comment, to decide).

## Owner decision
Units: **px, em and rem only** (no %). Applies to image sizes, table column widths and row heights. A bare number
means px. A constant used as a size must be a number (px) or text like `20em`.
