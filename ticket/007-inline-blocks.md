# 007: Inline blocks and database value lookups

Status: in progress (interpretation confirmed by owner)
Raised: 2026-11-27

Request: "add support for inline blocks, as well as getting values from database by referring to key value and column".

Default interpretation (being built):
- **Inline blocks** = chips that live inside a line of text, next to words, stored in the block's markdown text as a
  token: `{{kind:arg|arg}}`. First kinds: **value** (database lookup) and **date**. Page mentions (`@`) stay links.
- **Value lookup** `{{value:<dbId>|<key>|<colId>}}`: finds the row whose primary key (the same key the record preview
  block uses) equals `<key>` and shows that column's value, live. Missing row/column shows a visible "not found" chip.
  Inserted from the `/` menu ("Database value") or by typing `{{`; picker = database → key → column.
- Markdown export writes the current value as plain text.


## Done
`{{value:…}}` and `{{date:…}}` chips, picker from `/` or `{{`, live values, Markdown export (commit "Inline chips").

## Next: preset chips (owner request)
- A **chip preset** saves a database + column (+ name, optional fixed key) so the same kind of chip can be reused to
  fill values quickly: insert the preset, pick only the key.
- Token `{{preset:<presetId>|<key>}}`; presets live on the database page (`chipPresets: [{ id, name, colId, key? }]`),
  so editing a preset (e.g. its column) updates every chip using it. Deleted preset → "Not found" chip.
- Inserted from `/` (each preset listed by name) and from the `{{` picker; presets managed from the picker
  (create from the current choice, rename, delete with a count of chips using it).

## Owner decision: more chip kinds
All four:
- **Page chip:** a page mention shown as a chip with icon and live title.
- **Checkbox:** a tickable box inside text (`{{check:0|1}}`).
- **Status tag:** a coloured tag from a short list (list defined per repository).
- **Inline formula:** `{{= expr}}` using the formula engine, with constants (ticket 009), database values and
  presets.
