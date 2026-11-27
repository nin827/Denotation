# 022: Inline charts, function graphs and math (LaTeX), with dedicated editors

Status: future (not scheduled)
Raised: 2026-11-27

Request: inline charts, graphs and functions (LaTeX), as inline chips and blocks, each opening a **dedicated editor**
when clicked into.

## Kinds
- **Math (LaTeX):** inline `{{math:...}}` and a display block. In-house renderer (no KaTeX/MathJax: no packages):
  a LaTeX subset (fractions, roots, sub/superscripts, Greek, operators, sums/integrals, matrices, `\text`) parsed to
  a tree and drawn as HTML/CSS or SVG; unsupported commands shown as source, never executed.
- **Function graphs:** plot `y = f(x)` (several functions, domain, axes, grid, points). Expressions use the existing
  sandboxed formula engine (no `eval`); may refer to constants (ticket 009) and database values.
- **Inline charts:** sparkline / mini bar / pie / progress inside a line of text, fed by a list of numbers, a database
  column (with view filters) or a formula. Block-size version reuses the database chart view.

## Dedicated editor (all kinds)
- Clicking (or Enter on) a chip opens an editor popover (a sheet on phones): source on one side, live preview on the
  other, errors shown inline with an icon and text. Esc / outside click saves; Undo restores.
- Math editor: LaTeX text box + symbol palette. Graph editor: function list, domain/range, colours (12-hue set).
  Chart editor: data source picker, chart type, colours, labels.
- Keyboard-first and accessible: chips have a text alternative (LaTeX source / function / data summary).

## Storage and export (default plan)
- Tokens `{{math:<latex>}}`, `{{plot:<json>}}`, `{{chart:<json>}}` (escaped like other tokens); block types `math`,
  `plot`, `chart`.
- Markdown export: math as `$...$` / `$$...$$`; plots and charts as text (expression / data table), optional SVG in
  ZIP exports.

## Open questions
- How much of LaTeX to cover first.
- Live-updating charts from databases inside text: refresh on every change or on open?
