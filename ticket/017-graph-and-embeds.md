# 017: Graph view, page/heading/block embeds, hidden links, graph styling

Status: queued (after 013 and 015; graph styling rules use page properties from 015)
Raised: 2026-11-27

## Links and embeds (stored by id)
- `[[PAGE]]` links a page. When typed or pasted, the title is matched (picker as you type) and **stored as the page
  id**; the shown text always follows the page's current title, so renames update everywhere. Every block already
  has an id; ids are kept stable and exported in JSON.
- `![[PAGE]]` also just links to the page (owner's choice; no embed).
- `![[PAGE][HEADING]]` shows that page's section under the heading, inline (live, read-only, with "open" link).
- `![[PAGE](CONTENT)]` shows chosen blocks from that page; any block can be picked (picker lists the page's blocks,
  stored as block ids).
- **Recursion:** embeds that would include themselves (directly or through other embeds) show a warning box instead
  of rendering, naming the loop.
- **Hidden links:** `x[[PAGE]]` is a normal link in the text, but the `x` isn't displayed and the link draws **no
  edge** in the graph. If the target links back without `x`, that link shows as a **one-way** arrow (target → this).
- Markdown export: `[[Title]]`-style or relative links; embeds export as their text.

## Graph view
- **Global graph** (sidebar ⋯ → Graph, per repository or the whole workspace): force layout in house (canvas or
  SVG, no library), pan/zoom, drag, search, filters (repository, tags/properties, orphans, depth), click to open,
  hover to highlight neighbours. Keyboard accessible list fallback.
- **Local graph:** for the current page, neighbours up to N steps (1–3), in a side panel.
- **Graph block** (`/graph`): an embedded global or local graph with its own filters.
- **Database rows:** not shown by default (filter to include chosen databases). Exception: a row linked to or from a
  page by a normal link appears; an `x`-prefixed link doesn't count.

## Node styling
- Per page: graph **icon**, **colour** and **size** can be set explicitly (page ⋯ → Graph appearance).
- **Rules** (graph settings): conditions on page properties, type, repository, tags, link count…
  e.g. `Status is Done → colour green, icon check`, `Type is Person → icon user, size 2×`. First matching rule wins;
  an explicit per-page setting beats rules.
- Size can also follow link count (default) or be fixed.

## Performance (owner: must be optimized and smooth)
- Target: 60 fps pan/zoom/drag and settled layout within ~1 s for 1000 nodes / 3000 edges on a mid-range phone;
  usable at 5000 nodes.
- Canvas rendering (not one DOM/SVG node per item), drawn only on change via requestAnimationFrame, with
  devicePixelRatio scaling; labels drawn only when zoomed in enough or on hover; level-of-detail for icons.
- Force layout with a spatial grid or Barnes–Hut for repulsion (O(n log n)), cooling schedule, and simulation stopped
  once settled; optionally run in a Web Worker so the UI never blocks. Positions cached per graph so reopening is
  instant.
- Graph data built incrementally from a link index (updated on page save), not by re-scanning every page on open.
- Hit-testing through the same spatial grid; pointer events coalesced.
- Reduced motion: no animation, layout computed then shown.
- A benchmark (Node for layout, Playwright for frame times) with before/after numbers in the report; add it to the
  test suite.
