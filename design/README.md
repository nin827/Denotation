# Denotation design

Clean and minimal. The source of truth is `public/css/style.css`; `design/index.html` is a live guide that links it
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
| `--muted` | oklch(0.45 0 0) | #667085 | #8d97a6 |
| `--border` | oklch(0.78 0 0) | #dde2ea | #2d343f |
| `--danger` | #b3302b | #c93c37 | #ff7b72 |
| `--scrim` | rgba(15,20,30,.45) | rgba(15,20,30,.45) | rgba(0,0,0,.6) |
| `--on-accent` | #ffffff | #ffffff | #16150f |
| `--c-gray` | #6b6a67 | #787774 | #9b9b9b |
| `--c-brown` | #8a5a45 | #9f6b53 | #bf7e63 |
| `--c-orange` | #b85f0a | #d9730d | #e8893a |
| `--c-yellow` | #94690f | #cb912f | #d9a441 |
| `--c-green` | #387352 | #448361 | #5fb08a |
| `--c-blue` | #2b6a91 | #337ea9 | #5aa5d3 |
| `--c-purple` | #7d54a0 | #9065b0 | #b48ad4 |
| `--c-pink` | #ab3e76 | #c14c8a | #e07aaf |
| `--c-red` | #bd3b36 | #d44c47 | #ef7570 |

`--c-*` are the label/option colours (chips, select options, favourite star). `color-scheme` follows the mode.

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

- **Fonts** (prefs.font): System sans (default) `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`; System serif `Georgia, "Times New Roman", Times, serif`; System monospace `ui-monospace, "SF Mono", Menlo, Consolas, monospace`; vendored Noto Sans, Noto Serif, Noto Sans Mono (variable, `public/fonts`). Installed fonts are listed separately and never recommended. `--mono` is used for code, cell values and keys; choosing Noto Sans Mono also sets it.
- **Base size** `--font-size`: 15px (12-24 in prefs), line-height 1.5.
- **Headings** (blocks): H1 1.9rem/700, H2 1.45rem/650, H3 1.2rem/650, H4 1.02rem/650; page title `clamp(1.45rem, 6.2vw, 2rem)` / 700. Prefs `headingStep` > 0 overrides via `--h1-size`..`--h4-size`: `size(n) = base + intercept + step * (5 - n)`.
- **Small text:** 13px hints/labels/menu header, 12px footers and hints, 11px uppercase section labels (`letter-spacing .06em`, `--muted`).
- Weights: 400 body, 600 emphasis and active rows, 650-700 headings.

## Spacing, radius, shadow, borders

- **Radius:** `--radius` 6px (buttons, inputs, cards, callouts); 8px menus, toasts, repo cards; 10px modals; 4-5px small chips, menu rows, handles; 10px pills (chips); 50% swatches.
- **Borders:** 1px `--border`. Tables use 1px grid lines; headers on `--bg-soft`. Dividers are 1px `--border`.
- **Spacing:** 4/6/8/10/12/16px steps. Gutters 16px minimum; main column `clamp(16px, 6vw, 96px)`, doc max width 860px.
- **Shadow:** only on floating layers: menu `0 8px 28px rgba(0,0,0,.22)`, modal `0 10px 40px rgba(0,0,0,.3)`, toast `0 6px 24px rgba(0,0,0,.25)`, overlay sidebar `0 0 40px rgba(0,0,0,.35)`. Nothing else has a shadow.
- **Focus:** 2px `--accent` outline on every focusable control (`:focus-visible`).

## Iconography

Lucide only, via `ico(name)` from `public/js/icons/index.js` (inline SVG, 24 viewBox, stroke 2, `currentColor`, `aria-hidden`).
Default size `1.1em`; 12px twist, 14px caret/row action/font check, 15px gutter handle, 16px segmented/swatch/tool, 18px floating sidebar-open button,
`1.15em` icon buttons. Icons are `--muted` unless interactive/active. Pair icon-only buttons with `aria-label` and `title`.

## Components (class names)

- **Buttons:** `button` (default, `--bg-soft`, 1px border, 4px 10px), `button.primary` (accent), `button.danger` (red text), `button.icon` (borderless, muted; `.on` accent, `.disabled` 35%), `:disabled` dimmed. Button with icon + text becomes inline-flex with 6px gap.
- **Inputs:** `input`, `select`, `textarea` (`--bg`, 1px border, 4px 8px). Settings rows `.set-row` (label 120px + control), `.set-check`. Modal labels `.modal label` (muted, stacked). Hints `.hint`.
- **Menus / popovers:** `.menu` (240px, 8px radius, shadow) with `.menu-item` (`.active`, `.danger`, `.disabled`), `.menu-icon`, `.menu-label`, `.menu-hint`, `.menu-header`, `.menu-empty`, `.menu-swatch`.
- **Modal:** `.modal-overlay > .modal` with `h3`, content, `.modal-error`, `.modal-actions` (right-aligned; primary last). Overlay uses `--scrim`; Esc and backdrop close.
- **Toasts:** `.toasts > .toast` (inverted: `--text` on `--bg`), `.toast.error` (danger, role alert, 8s; info 3.5s).
- **Sidebar:** `.side-item` (`.active` = accent-soft + ink + 600), `.twist`/`.twist-gap`, `.side-icon`, `.side-title`, `.side-section`, `.side-tools .tool`, `.brand`, `.side-footer`. 260px wide; overlay below the pinned layout.
- **Segmented control:** `.seg` with `button[aria-pressed]`; pressed = accent fill. Used for theme mode.
- **Swatches:** `.swatch-grid > .swatch[aria-pressed]` (30px circle, check icon when selected), `.swatch-random` conic gradient.
- **Chips:** `.chip` (muted pill), `.chip-btn` (clickable), `.badge` (accent count), `.banner` (warning strip).
- **Cards:** `.card` (+ `.card-title`, `.card-chips`, `.card-tools`; hover border accent), `.repo-card`, `.post`, `.dash-tile`, `.board-col`.
- **Tables:** `.db-table`, `.tbl`, `.sheet-table`, `.pivot-table`: 1px grid, header on `--bg-soft`, wrapped in an `overflow-x: auto` box; mono + tabular numbers for cell values.
- **Pickers/fonts:** `.font-opt` (pressed = accent-soft + check), `.icon-grid`, `.emoji-grid`.

## Motion

Hover/press feedback 70ms linear (colour only, `:active` brightness .94). Menus/popovers/toasts `pop-in` 90ms ease-out (3px, scale .985); modal 110ms; overlay fade 90ms.
Twist rotate 100ms. No other animation. Reduced motion removes all of the above.

## Cleanup candidates

Where `style.css` is inconsistent, the rule should be:

1. Radius: use `--radius` (6px) for controls and cards; use one larger value (8px) for floating layers (menu, toast, modal currently 10px) and cards-as-links (`.repo-card`).
2. Danger/orange tokens: `--danger` is declared in `:root` and again per mode; drop the root copy.
3. Duplicate rules: `.brand`, `.side-*`, `.side-list`, `.twist` are defined 2-3 times (original, "compact", "roomier"); keep the last values only.
4. Focus rings: two conflicting rules (`outline-offset: -1px` vs `1px`); use one offset (1px).
5. Reduced motion: the first `@media (prefers-reduced-motion)` rule only sets scroll-behavior; merge with the animation one, and also drop the 100ms transforms.
6. Shadows: four different blur/alpha values; use two tokens (floating, overlay).
7. Hardcoded colours: `#ffffff` / `#16150f` text on swatches, `.cal-chip`, conic gradient; derive from `--on-accent`.
8. Type sizes: 11/12/13/14px, `.8em`, `.85em`, `.9em` mix; settle on 11, 12, 13, base.
9. Icon sizes: many one-off rules (12, 14, 15, 16, 18, 1.05em, 1.1em, 1.2em, 1.3em); settle on 12/14/16/18 plus the `1.1em` default.
10. Hover-reveal elements use opacity 0 (`.quick`, `.cover-btn`, `.tbl-controls`, `.gutter`) vs `visibility`/`display` for others; pick one pattern and keep `(hover: none)` overrides.
