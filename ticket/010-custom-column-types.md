# 010: Custom columns and data types (nested, JSON-defined)

Status: queued (starts after the performance pass, which owns the database UI files)
Raised: 2026-11-27

Request: custom columns and data types for databases, including detailed nested columns, with the column setup stored
purely as JSON. Reference: idlecrafts `build` branch, `source/_editor/workshop/workshop/action/` (Action workshop).
There, a type text per field (`typeSpec`) drives a generated nested editor and values are stored as JSON.

Plan (mirrors the Action workshop grammar):
- New column type **Custom (JSON)**: the column holds a **type text**, and each cell holds a JSON value checked against it.
  - Scalars: `String`, `bool`, `int`, `float`, ranges `int(0..10)` / `float(..1.5)` (clamped on commit, flagged).
  - Enums: `("low", "mid", "high")` picks one; `Array[("a", "b")]` picks any.
  - Lists: `Array[T]`.
  - Structs: `Dictionary{name: String, level: int(1..99), stats: Dictionary{hp: int, sp: int}}` (fixed keys, in order,
    nested to any depth).
  - Unions: `String | Dictionary{...}` with a shape switch.
- Editing: a generated nested form (fields, number pads with ranges, enum pickers, add/remove/reorder list items,
  shape switch), plus a raw JSON tab. Invalid values are saved as written but flagged, never silently dropped.
- Table/sheet cells show a compact summary (e.g. `{name: Ava, level: 12, …}`). Row pages show the full form.
- **Columns as JSON:** "Edit columns as JSON" on a database shows its whole column setup (columns + named types) as
  JSON. It's validated on save and keeps column ids, so existing values survive.
- CSV export writes the JSON text. Filters/sorts work on the JSON text, plus dotted paths (`stats.hp`) for
  struct fields.

Open question: should nested struct fields also be usable directly as filter/sort/group keys and in formulas
(e.g. `prop("Stats").hp`)?

## Owner decision
No stored type presets (no data-level `types`). Build only the script-level engine: the type-text parser, validator and
generated nested editor, so any setup is possible by writing the column's type text (or the columns JSON).
