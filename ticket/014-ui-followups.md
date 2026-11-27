# 014: UI follow-ups that need JS or markup

Status: queued (after the performance pass)
Raised: 2026-11-27 (from the CSS polish pass)

1. To-do checkbox: wrap it in a `<label>` of at least 40px (it's 22px on touch).
2. `dbView.js`: `.view-tab` is a `div[role=tab]` holding buttons, which is invalid ARIA. Use plain buttons or drop
   the roles.
3. Column resize has no keyboard path and shows only on hover: add **Column width…** to the column menu.
4. Calendar chips are 24px on touch: tapping a day should open its list.
5. Toasts: add a leading icon (check / alert) so state isn't carried by colour alone.
6. `lock.css` / `sync.css`: adopt the new `--ico-*`, `--fs-*` and `--border-ctl` tokens.
