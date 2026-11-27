# 011: Column groups with labels

Status: queued (with ticket 010, after the performance pass)
Raised: 2026-11-27

Request: group database columns and label each group.

Plan:
- Stored on the database: `columnGroups: [{ id, label, colIds }]`. A column belongs to at most one group, and a group's
  columns sit next to each other in column order (moving a column into a group moves it beside the others).
- Table and sheet show a second header row above the column names, with each label spanning its columns.
  Ungrouped columns leave that cell blank.
- **Make a group:** select columns (or use a column header's menu → **Group with…**) and name it.
- **Group label menu** (right-click or click): rename, add/remove columns, collapse/expand (shows one narrow
  "Label (n)" column), ungroup.
- Row pages and the record preview list properties under their group headings. CSV export keeps flat columns.
  Columns-as-JSON (ticket 010) includes `columnGroups`.
- Collapsed state is per view. Groups themselves are per database.

## Owner decision
Groups can nest, **two levels at most**: a group may hold columns and subgroups; a subgroup holds only columns.
Stored as `columnGroups: [{ id, label, parentId?, colIds }]` (a `parentId` must point to a top-level group).
Table and sheet then show up to two label rows above the column names. Moving a subgroup moves its columns with it.
