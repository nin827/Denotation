# Denotation
For personal use as in-house Notion/Obsidian. Yes, it is vibe-coded.

Plain HTML + ES modules in `public/`, no framework, no runtime build step.

```bash
npm start              # serve public/ at http://localhost:8080
npm run build          # optional: single-file pages in dist/ (artifact fragment + standalone)
node test/e2e/smoke.cjs  # browser smoke test (Playwright + Chromium)
```

Data is stored in this browser (localStorage) unless running inside a Claude artifact.
Use Export / Import in the sidebar footer to back up or move a workspace.
