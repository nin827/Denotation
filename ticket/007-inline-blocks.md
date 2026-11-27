# 007: Inline blocks and database value lookups

Status: open
Raised: 2026-11-27

Request: "add support for inline blocks, as well as getting values from database by referring to key value and column".

Default interpretation (being built):
- **Inline blocks** = chips that live inside a line of text, next to words, stored in the block's markdown text as a
  token: `{{kind:arg|arg}}`. First kinds: **value** (database lookup) and **date**. Page mentions (`@`) stay links.
- **Value lookup** `{{value:<dbId>|<key>|<colId>}}`: finds the row whose primary key (the same key the record preview
  block uses) equals `<key>` and shows that column's value, live. Missing row/column shows a visible "not found" chip.
  Inserted from the `/` menu ("Database value") or by typing `{{`; picker = database → key → column.
- Markdown export writes the current value as plain text.

Open question: did "inline blocks" mean something else (e.g. blocks side by side in a row, or a block embedded inside
another block's text)?
