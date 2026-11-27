# 015: Page properties, templates, callout presets, automatic callouts, database pages, Archive

Status: queued (after the performance pass; touches the editor and database UI)
Raised: 2026-11-27

## Page properties
Any page (not only database rows) can have properties: name, type (text, number, date, select, multi-select,
checkbox, URL, page link) and value. They're shown under the title, with **Add a property** in the page ⋯ menu.
Stored as `page.props: [{ id, name, type, value, options? }]`. Search and quick find see them.

## Page templates
- Any page can be marked **Template** (page ⋯ menu); templates are listed in a **Templates** group per repository.
- **New → From template…** copies the template's blocks, properties and automatic-callout rules into a new page.
- A database can also have row templates ("New row from template").

## Callout presets (owner: keep the callout, add presets, not hard-coded)
- Presets (e.g. Info, Tip, Note, Success, Warning, Danger, Question, Quote) live in one data file,
  `public/js/blocks/callout-presets.js`: `[{ id, label, icon, color, bg }]`. Updates change only that file.
- A callout stores `preset: <id>` and follows the preset's icon and colours. The user can still set a custom icon or
  colour on one callout, which overrides the preset for that callout only (**Reset to preset** undoes it).
- Picker: the callout's icon button shows the presets first, then the emoji/icon picker.

## Automatic callouts (owner: rules on properties)
- Rules: `{ when: { prop, op: "is"|"is not"|"empty"|"not empty"|"contains"|"before"|"after", value }, preset, text }`.
  Example: Status is Draft → Warning callout "Draft — not reviewed yet".
- Rules are set on a template, a database (applies to its row pages) or a parent page (applies to its sub-pages).
- Matching callouts show at the top of the page, live as properties change. They're generated, not stored as blocks,
  and marked "automatic"; **Pin as block** turns one into a normal callout.

## Database pages (owner: rows also act as pages, like Notion)
- Per database, **Row pages** is a toggle, **off by default for new databases**. Existing databases keep it on.
- On: each row opens as a page with its own blocks (today's behaviour).
- Off: rows are data only (no page body, no open-as-page).
- Turning it off when rows have written content asks, for those rows' page bodies: **Move to Archive** or
  **Delete** (delete goes to Trash).

## Archive section (owner: always on, like Trash)
- A permanent **Archive** entry in the sidebar ⋯ menu, beside Trash. Archived items are kept out of the page tree and
  search (with an "include archived" filter), are read-only until restored, and can be restored to their origin or
  moved to Trash.
- Row page bodies archived from a database become archive pages titled after the row, with the row's values as page
  properties, and a link back if the row still exists.
- Any page can also be archived from its page menu.
