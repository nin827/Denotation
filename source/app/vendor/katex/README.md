# KaTeX (vendored)

- Version: 0.19.1 (MIT, see `LICENSE`), from the npm package `katex@0.19.1` (`dist/`).
- `katex.esm.js` is `dist/katex.mjs` renamed to `.js` so the service-worker precache list (which matches `.js`) includes it.
- `katex.min.css` is `dist/katex.min.css` with the `.woff` / `.ttf` fallbacks removed; fonts are the `woff2` files in `fonts/` (relative urls).
- Loaded lazily by `js/math/katex.js` (dynamic `import()`) only when math is first rendered. Never loaded from a CDN.
- Update: `npm pack katex`, copy the same three things, strip the CSS fallbacks, run `node work/tools/gen-sw-files.mjs`.
