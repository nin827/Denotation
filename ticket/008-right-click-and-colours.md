# 008: Right-click coverage and 12-hue text/background colours

Status: in progress
Raised: 2026-11-27

## Right-click audit
Before: only sidebar page rows had a context menu (right-click, long-press, Shift+F10). Blocks, database rows and
cards, column headers and view tabs fell through to the browser menu, though most had a button menu.
Plan: one shared helper (`ui/contextMenu.js`) that opens the existing button menus. Database views first; blocks
(same menu as the block handle) after the inline-blocks work. Native menu stays on inputs, links and selected text.

## Colours
Before: 9 named colours (gray, brown, orange, yellow, green, blue, purple, pink, red) for block text and background.
Plan:
- 12 hues (0, 30, ..., 330) for text and background, OKLCH like the accent (readable in light and dark mode).
- Plus **grey** as a background highlight only (no grey text colour).
- Stored as `block.color = <hue>` and `block.bg = <hue> | "grey"`. Legacy names map to the nearest hue; legacy grey
  text becomes default.
