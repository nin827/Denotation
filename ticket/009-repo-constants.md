# 009: Repo-wide constants

Status: queued (starts after the performance pass, which owns the editor files)
Raised: 2026-11-27

Request: label a constant, e.g. `foundedyear` = `2029`, per repository. Typing `@foundedyear` shows a dropdown below the
text to insert it as a variable or keep plain text. Inserted variables are inline chips that update in real time.

Plan:
- Stored on the repository page: `constants: [{ id, name, value }]`. Names are unique per repo, letters/digits/`_`/`-`,
  case-insensitive match.
- Token `{{const:<id>}}` (id-based, so renaming a constant keeps its chips). Resolves through the page's repository;
  a deleted constant or a page moved to another repo without it shows "Not found".
- `@` menu: matching constants listed above page mentions ("foundedyear = 2029"). Enter/click inserts the chip;
  Escape or typing on keeps plain text.
- Manage from the repository's page menu → **Constants…** (add, rename, edit value, delete with a count of chips
  using it). Editing a value updates every chip at once (same event pattern as preset chips).
- Markdown export writes the value; JSON keeps tokens; search sees the value.

Open question: values are plain text for now. Should they also support numbers/dates with formatting, or use in formulas?
