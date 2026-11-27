# 002: "Denotion" or "Denotation"?

Status: resolved (visible name is Denotation; keys keep denotion:)
Raised: 2026-11-27

The repo is called Denotation, but the app shows "Denotion": sidebar brand, `<title>`, export files
(`denotion-YYYY-MM-DD.json`), the import check ("Not a Denotion export file"), and storage keys (`denotion:*`).

Options:
1. **Recommended:** rename the visible name to Denotation (title, brand, export file name, messages), but keep the
   `denotion:` storage keys and accept both names on import, so existing data and backups keep working.
2. Keep "Denotion" as the app name and Denotation as the repo name.

The user guide currently notes the mismatch at the top; remove that note once this is decided.

## Owner decision
Option 1: show **Denotation** everywhere visible (title, brand, export file names, messages). Keep the `denotion:`
storage keys and accept both names on import. Remove the mismatch note from the user guide once done.
