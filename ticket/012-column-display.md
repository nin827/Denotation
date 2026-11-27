# 012: Per-column display: obfuscate, hide, wrap

Status: queued (with tickets 010/011, after the performance pass)
Raised: 2026-11-27

Request: per-column display options, useful for large columns.

Plan (column setting `display: { mode, wrap }`, in the column editor and the column header's right-click menu):
- **Show** (default): the value, clipped to one line.
- **Obfuscate:** a non-empty cell shows `———` (triple em-dash); an empty cell stays empty. The full value appears
  only when the cell is opened for editing, or on the row page. Search, filters, sorts and formulas still use the
  real value. It's for tidiness and screen privacy, not security.
- **Hide contents:** the column stays, at a narrow width, with blank cells; open the cell or the row page to see
  the value.
- **Wrap:** on/off. When on, long text wraps onto several lines instead of being clipped.
- Applies to table, sheet, board/gallery/list card properties and the record preview block. Row pages always show
  the full value. CSV/JSON export always writes the real value.
- Stored on the column, so it applies to every view of the database. Columns-as-JSON (ticket 010) includes it.

Open question: should a view be able to override the column's setting, e.g. show everything in one view?

## Owner decision: marquee
Add **Marquee**: text too long for its cell scrolls sideways, reusing the sidebar's long-title marquee. It stays still
under `prefers-reduced-motion` (clipped instead). Marquee, Wrap and Obfuscate are mutually exclusive, so the setting
becomes one choice: `display: "clip" | "wrap" | "marquee" | "obfuscate" | "hide"` (default `clip`).
