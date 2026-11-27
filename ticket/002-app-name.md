# 002: "Denotion" or "Denotation"?

Status: open
Raised: 2026-11-27

The repo is called Denotation, but the app shows "Denotion": sidebar brand, `<title>`, export files
(`denotion-YYYY-MM-DD.json`), the import check ("Not a Denotion export file"), and storage keys (`denotion:*`).

Options:
1. **Recommended:** rename the visible name to Denotation (title, brand, export file name, messages), but keep the
   `denotion:` storage keys and accept both names on import, so existing data and backups keep working.
2. Keep "Denotion" as the app name and Denotation as the repo name.

The user guide currently notes the mismatch at the top; remove that note once this is decided.
