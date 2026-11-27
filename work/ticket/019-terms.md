# 019: Term inline chips

Status: resolved (built; see commit "Terms"). Was: queued (after the page batch; shares the chip and editor files)
Raised: 2026-11-27

Request: a **Term** inline block. Its text is always bold and it acts as a variable (edit once, every chip
updates), but terms are stored separately from repo constants so they don't clutter them. An icon can be shown to
the right of the text (default: none). Terms can be categorised and subcategorised, colour-coded and icon-marked.

## Owner decisions
- **Per repository:** `repo.terms: [{ id, text, definition?, category?, subcategory?, hue?, icon? }]`, managed under
  right-click on the repository → **Terms…** (a third tab next to Constants and Statuses).
- **Definition:** a short description shown on hover, focus or tap (accessible tooltip / popover).
- **Insert:** `@` dropdown (with constants and pages) and `/Term`.

## Plan
- Token `{{term:<id>}}`. The chip shows the term's text in **bold**, tinted by its hue (12-hue set, or none), with its
  icon to the right if set. Text and hue together, so it's never colour alone. Missing → "Not found".
- **Categories:** free-text category + subcategory per term (two levels, like column groups). The Terms dialog
  groups by them, filters, and lets you set a default hue/icon per category that terms inherit unless set
  themselves.
- Icon picker: Lucide icons from the app's set (and emoji), default blank.
- Search sees term text and definitions. Markdown export writes the term text (bold), definition dropped.
- Delete shows how many chips use the term.

## Owner request: branching terms
"Long Branch, Short Branch, both are still grouped under Branch."
- A term can have a **parent term**: `parentId` on the term record. `Branch` is the base; `Long Branch` and
  `Short Branch` are its branches. Each branch is still its own term (own id, text, definition, chips).
- Branches **inherit** hue, icon and category from the parent unless set themselves.
- One level only (a branch can't have branches), like the simple-first default; deeper nesting later if asked.
- Terms dialog shows each base term with its branches indented under it; "Add branch" on a term's menu.
- The hover/tap card on a branch shows "Branch of **Branch**" (with the parent's definition below its own).
- Finding uses of a term (and the delete count) can include its branches.
- Deleting a parent asks: also delete branches, or keep them as plain terms.

## Built notes
- Not yet hooked: repo right-click "Terms…" entry, `@` menu entries and search of term text (patches handed to the
  links agent, which owns sidebar.js / blockEditor.js / workspace.js). Meanwhile Terms open from repository settings.
- Duplicate term texts are allowed; deleted terms leave "Not found" chips; locked pages untested.
