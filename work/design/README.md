# Denotation design

Clean and minimal. The source of truth is `source/app/css/style.css`; `work/design/index.html` is a live guide that links it
(serve the repo root, open `/design/`). Keep both in sync with this file.

## Principles

- **Quiet, content-first.** The page is the interface; chrome recedes. No decoration for its own sake.
- **One theme, one accent.** Everything is neutral except the accent, which marks selection, primary actions and focus.
- **Keyboard and touch.** Every action reachable by keyboard; no hover-only affordances (`@media (hover: none)` shows them); targets comfortable on touch.
- **Mobile-first from 360px.** No horizontal page scroll (tables scroll in their own box), 16px side gutters, `env(safe-area-inset-*)` respected, inputs at 16px on phones.
- **Never colour alone.** Selected, correct and error states also show an icon (check) or label.
- **Reduced motion.** Respect `prefers-reduced-motion`; motion is short and functional.

## Theme: one theme, four value modes

`prefs.mode` is applied as `<html data-mode>`: **neutral** (default, soft grey, counts as light for the accent), **light**, **dark**,
**variable** (resolves to light 07:00-19:00 local time, dark otherwise; rechecked every minute and on tab show).
No presets, no custom background/text colours.

| Token | Neutral | Light | Dark |
|---|---|---|---|
| `--bg` | oklch(0.90 0 0) | #ffffff | #14171c |
| `--bg-soft` | oklch(0.87 0 0) | #f4f6f9 | #1a1e25 |
| `--bg-hover` | oklch(0.83 0 0) | #e7ebf1 | #252b34 |
| `--text` | oklch(0.22 0 0) | #1f2530 | #e6e9ee |
| `--muted` | oklch(0.42 0 0) | #5b6577 | #8d97a6 |
| `--border` | oklch(0.78 0 0) | #dde2ea | #2d343f |
| `--border-ctl` | oklch(0.56 0 0) | #848d9d | #667185 |
| `--danger` | #b3302b | #c93c37 | #ff7b72 |
| `--code-fg` | #8f2a26 | #a52f2b | #ff9a93 |
| `--scrim` | rgba(15,20,30,.45) | rgba(15,20,30,.45) | rgba(0,0,0,.6) |
| `--on-accent` | #ffffff | #ffffff | #16150f |
| `--c-gray` | #6b6a67 | #787774 | #9b9b9b |
| `--c-brown` | #8a5a45 | #9f6b53 | #bf7e63 |
| `--c-orange` | #b85f0a | #d9730d | #e8893a |
| `--c-yellow` | #94690f | #a97410 | #d9a441 |
| `--c-green` | #387352 | #448361 | #5fb08a |
| `--c-blue` | #2b6a91 | #337ea9 | #5aa5d3 |
| `--c-purple` | #7d54a0 | #9065b0 | #b48ad4 |
| `--c-pink` | #ab3e76 | #c14c8a | #e07aaf |
| `--c-red` | #bd3b36 | #d44c47 | #ef7570 |

`--c-*` are the label/option colours (chips, select options, favourite star). `--code-fg` is the inline-code text colour. `color-scheme` follows the mode.
`--border` is for decorative dividers and cards (about 1.3-1.5:1); `--border-ctl` outlines form controls (inputs, selects, textareas, segmented control) and is at least 3:1 on `--bg` in every mode.

### Contrast (WCAG 2.2)

Measured on the resolved tokens; text needs 4.5:1, state-bearing UI (borders, icons) 3:1.

| Pair | Neutral | Light | Dark |
|---|---|---|---|
| `--text` on `--bg` | 11+ | 14+ | 14+ |
| `--muted` on `--bg` / `--bg-soft` / `--bg-hover` | 6.3 / 5.7 / 5.0 | 5.9 / 5.4 / 4.9 | 6.1 / 5.7 / 4.8 |
| `--danger` on `--bg` | 4.6 | 5.0 | 7.1 |
| `--code-fg` on `--bg-hover` (inline code) | 4.9 | 5.8 | 7.0 |
| `--on-accent` on `--accent` (worst of 25 accents) | 5.0 | 5.0 | 6.8 |
| `--accent` on `--bg` (focus ring, worst accent) | 3.7 | 5.0 | 6.7 |
| `--accent-ink` on `--accent-soft` (worst accent) | 5.3 | 6.8 | 8.4 |
| `--border-ctl` on `--bg` / `--bg-soft` | 3.5 / 3.2 | 3.4 / 3.1 | 3.7 / 3.4 |
| `--c-yellow` on `--bg` (favourite star) | 3.6 | 4.0 | 8.0 |

Block placeholders use `--muted` at full opacity (no `opacity` fade). Disabled controls are exempt and dimmed to 50%.

## Block colours

Block text and background use 12 OKLCH hues (0 to 330 in 30 steps: Rose, Red, Orange, Yellow, Lime, Green, Teal, Cyan, Blue, Violet, Purple, Pink), plus **grey as a background only**. Stored as `block.color = <hue>` and `block.bg = <hue> | "grey"`; `normColor` / `normBg` in `blocks/model.js` map legacy names (red, blue, ...) to the nearest hue.
CSS sets `--blk-h` (text) and `--blk-bg-h` (background) inline on the block row, with `.has-color`, `.has-bg`, `.bg-grey`. Per-mode lightness/chroma tokens: `--blk-fg` (text L C), `--blk-tint` (background L C), `--blk-grey`.

| Mode | Text `L C` | Background `L C` | Grey bg | Worst text on page | Worst text on any tint | Default text on tint |
|---|---|---|---|---|---|---|
| Neutral | .40 .13 | .84 .05 | L .83 | 5.9 | 4.8 | 9.0 |
| Light | .48 .14 | .94 .04 | L .94 | 5.6 | 4.6 | 9.0 |
| Dark | .78 .12 | .32 .05 | L .32 | 8.5 | 5.9 | 9.0 |

Menu: `.color-pop` with two `.cp-grid` (6 per row; swatch 32px, 40px on coarse pointers), `.cp-sw` buttons labelled by hue name and degrees ("Red 30°"; names are plain words for people, degrees disambiguate). The selected swatch shows a check icon, `aria-pressed` is set, never colour alone.

## Accent

24 OKLCH hues (0 to 345 in 15 steps, chroma 0.16) plus grey, set as `--accent-h` / `--accent-c` on `<html>`; CSS derives the rest.
Default is **random**: one hue per page load, never grey. Stored as `prefs.accent = "random" | "grey" | <hue>`.

| Token | Neutral | Light | Dark |
|---|---|---|---|
| `--accent` | oklch(0.50 C H) | oklch(0.50 C H) | oklch(0.72 C H) |
| `--accent-soft` | oklch(0.84 C*0.25 H) | oklch(0.95 C*0.22 H) | oklch(0.30 C*0.45 H) |
| `--accent-ink` | oklch(0.38 C*0.875 H) | oklch(0.40 C*0.875 H) | oklch(0.85 C*0.6 H) |

Grey (`data-accent="grey"`, chroma 0): dark grey on neutral/light (`oklch(0.35 0 0)`), light grey on dark (`oklch(0.85 0 0)`).
Use: `--accent` for primary buttons, pressed segments, focus rings, drop targets, check fills; `--accent-soft` + `--accent-ink` for the active row and selected options.

## Typography

- **Fonts** (prefs.font): System sans (default) `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`; System serif `Georgia, "Times New Roman", Times, serif`; System monospace `ui-monospace, "SF Mono", Menlo, Consolas, monospace`; vendored Noto Sans, Noto Serif, Noto Sans Mono (variable, `source/app/fonts`). Installed fonts are listed separately and never recommended. `--mono` is used for code, cell values and keys; choosing Noto Sans Mono also sets it.
- **Base size** `--font-size`: 15px (12-24 in prefs), line-height 1.5.
- **Headings** (blocks): H1 1.9rem/700, H2 1.45rem/650, H3 1.2rem/650, H4 1.02rem/650; page title `clamp(1.45rem, 6.2vw, 2rem)` / 700. Prefs `headingStep` > 0 overrides via `--h1-size`..`--h4-size`: `size(n) = base + intercept + step * (5 - n)`.
- **Small text:** `--fs-ui` 14px compact UI, `--fs-md` 13px hints/labels/menu header, `--fs-sm` 12px footers and chips, `--fs-xs` 11px uppercase section labels (`letter-spacing .06em`, `--muted`).
- Weights: 400 body, 600 emphasis and active rows, 650-700 headings.

## Spacing, radius, shadow, type, focus

All scales are tokens on `:root` in `style.css`; the live guide shows them. Use the token, not a one-off value.

- **Radius:** `--r-xs` 4px (handles, menu rows, small chips, code spans), `--radius` 6px (buttons, inputs, cards, callouts, table boxes), `--r-md` 8px (menus, popovers, toasts, repo cards), `--r-lg` 12px (modals, bottom sheets), `--r-pill` 999px (chips, badges, today marker); `50%` swatches.
- **Borders:** 1px `--border`; form controls 1px `--border-ctl`. Tables use 1px grid lines; headers on `--bg-soft`. Dividers are 1px `--border`.
- **Spacing:** `--sp-2/4/6/8/12/16/24` (px in the name) for gaps and padding; `--gutter` 16px minimum side gutter. Main column `clamp(var(--gutter), 6vw, 96px)`, doc max width 860px.
- **Shadow:** two tokens, only on floating layers: `--shadow-float` (menus, popovers, colour picker, toasts) `0 8px 28px rgba(0,0,0,.22)`; `--shadow-overlay` (modals, overlay sidebar) `0 12px 40px rgba(0,0,0,.32)`. Nothing else has a shadow (the drop-line, frozen-column edge and swatch ring are lines, not shadows).
- **Type scale:** `--fs-xs` 11px (uppercase section labels), `--fs-sm` 12px (footers, chips, hints, shortcut hints), `--fs-md` 13px (hints, labels, menu header), `--fs-ui` 14px (menu rows, compact controls, outline), then the base `--font-size`. Inputs are 16px on phones. Inline pieces (inline code, chips) use `em` so they follow their line.
- **Focus:** one rule, `:focus-visible { outline: var(--ring); outline-offset: 1px }` where `--ring` is `2px solid var(--accent)`. Controls that sit flush in a clipping box (menu rows, segmented buttons, list rows, table cell inputs) use `outline-offset: -2px`. Text-editing surfaces (page title, block text, caption) show the caret instead.
- **Hover-reveal:** secondary controls (`.quick`, `.cover-btn`, `.tbl-controls`, `.code-tools`, `.cal-add`, `.card-tools`, row icons, `.gutter`, `.rp-gear`) use one pattern: `opacity: 0` until the owner is hovered or has keyboard focus (`:focus-within`). Opacity, never `display` or `visibility`, so they keep their space and stay in the tab order. Under `(hover: none)` and `(pointer: coarse)` they are always shown (the block handle at 60%).
- **Touch:** on `(pointer: coarse)` buttons, selects, inputs, menu rows and list rows are at least 40px high (44px for menu rows, side rows, dialog actions). Small hit areas that cannot grow without moving layout (the toggle caret) grow with a transparent `::after`.

## Iconography

Lucide only, via `ico(name)` from `source/app/js/icons/index.js` (inline SVG, 24 viewBox, stroke 2, `currentColor`, `aria-hidden`).
Default size `1.1em` (`.icon-svg`). Scale: `--ico-xs` 12px (sidebar twist), `--ico-sm` 14px (caret, row action, crumbs, font check, menu hint), `--ico-md` 16px (icon buttons, gutter handle, segmented, swatch, view-title), `--ico-lg` 18px (callout and page-link icons, floating sidebar-open button). Icons are `--muted` unless interactive/active. Pair icon-only buttons with `aria-label` and `title`.

## Components (class names)

- **Buttons:** `button` (default, `--bg-soft`, 1px `--border`, 4px 10px; `:disabled` 50% and `not-allowed`), `button.primary` (accent), `button.danger` (red text), `button.icon` (borderless, muted; `.on` accent, `.disabled` 35%), `:disabled` dimmed. Button with icon + text becomes inline-flex with 6px gap.
- **Inputs:** `input`, `select`, `textarea` (`--bg`, 1px border, 4px 8px). Settings rows `.set-row` (label 120px + control), `.set-check`. Modal labels `.modal label` (muted, stacked). Hints `.hint`.
- **Menus / popovers:** `.menu` (240px, `--r-md`, `--shadow-float`) with `.menu-item` (`.active`, `.danger`, `.disabled`), `.menu-icon`, `.menu-label`, `.menu-hint`, `.menu-header`, `.menu-empty`, `.menu-swatch`.
- **Modal:** `.modal-overlay > .modal` with `h3`, content, `.modal-error`, `.modal-actions` (right-aligned; primary last). Overlay uses `--scrim`; Esc and backdrop close.
- **Toasts:** `.toasts > .toast` (inverted: `--text` on `--bg`), `.toast.error` (danger, role alert, 8s; info 3.5s).
- **Sidebar:** `.side-item` (`.active` = accent-soft + ink + 600), `.twist`/`.twist-gap`, `.side-icon`, `.side-title`, `.side-section`, `.side-tools .tool`, `.brand`, `.side-footer`. 260px wide; overlay below the pinned layout.
- **Segmented control:** `.seg` with `button[aria-pressed]`; pressed = accent fill and weight 600 (and an icon where the markup adds one). Used for theme mode.
- **Swatches:** `.swatch-grid > .swatch[aria-pressed]` (30px circle, check icon when selected), `.swatch-random` conic gradient.
- **Chips:** `.chip` (muted pill), `.chip-btn` (clickable), `.badge` (accent count), `.banner` (warning strip).
- **Cards:** `.card` (+ `.card-title`, `.card-chips`, `.card-tools`; hover border accent), `.repo-card`, `.post`, `.dash-tile`, `.board-col`.
- **Tables:** `.db-table`, `.tbl`, `.sheet-table`, `.pivot-table`: 1px grid, header on `--bg-soft`, wrapped in an `overflow-x: auto` box; mono + tabular numbers for cell values.
- **Pickers/fonts:** `.font-opt` (pressed = accent-soft + check), `.icon-grid`, `.emoji-grid`.

## Motion

Hover/press feedback 70ms linear (colour only, `:active` brightness .94). Menus/toasts `pop-in` 90ms ease-out (3px, scale .985); modal 110ms; overlay fade 90ms.
Twist/caret rotate 100ms; gutter fade 100ms. No other animation. Under `prefers-reduced-motion: reduce` one rule (`*, *::before, *::after`) removes every animation and transition and smooth scrolling.

## Consistency rules (the former cleanup list, now applied)

1. One radius scale (`--r-xs`, `--radius`, `--r-md`, `--r-lg`, `--r-pill`); modals are 12px, chips are pills.
2. `--danger` is declared per mode only (no root copy).
3. Sidebar rules (`.brand`, `.side-*`, `.twist`) are defined once, in one block; the old "compact" and "roomier" layers are merged. `.side-actions`, `.tool`, `.popover`, `.pick-tab(s)`, `.pick-custom`, `.emoji-grid` had no markup and were removed.
4. One focus ring and one offset (1px outside, -2px inset where clipped); cards and posts keep the ring.
5. One reduced-motion rule that covers animation, transitions and scrolling.
6. Two shadow tokens.
7. Hard-coded colours derive from tokens: inline code uses `--code-fg`, the random-accent swatch gradient follows `--accent-l` and `--on-accent`.
8. Type sizes are tokens (11, 12, 13, 14, base); the stray `.75em` to `.95em` sizes are gone except inline pieces.
9. Icon sizes are tokens (12, 14, 16, 18 plus the 1.1em default).
10. Hover-reveal uses opacity everywhere, with `(hover: none)` and `(pointer: coarse)` overrides.

Still open: the checkbox marker in to-do blocks is 22px on touch (needs a label wrapper for a 40px target); the calendar chip stays 24px high inside a day cell; the column resize handle and the `.view-tab` wrapper (a `div[role=tab]` holding two buttons) need markup changes.
