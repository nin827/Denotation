# 001: Google Fonts break the no-third-party rule

Status: resolved
Raised: 2026-11-27

Settings → Appearance offers web fonts (Inter, Nunito, IBM Plex Sans, Lora, Merriweather, Source Serif 4, Playfair
Display, JetBrains Mono) loaded from `fonts.googleapis.com` (`prefs.js` `googleFontUrl`, `ui/appearance.js`). That's a
third-party request, and the fonts don't work offline.

Options:
1. **Recommended:** keep only system stacks (sans, serif, mono) plus the "custom font name" field, which uses fonts
   already installed on the device. Drop the Google loader.
2. Vendor a few fonts as `.woff2` files under `public/fonts/` (adds licences and weight to the repo).
3. Keep Google Fonts as an opt-in that is off by default.

## Resolution

Status: resolved (2026-11-27). Drop the Google Fonts loader. The Recommended fonts are the system stacks plus vendored
Noto Sans, Noto Serif and Noto Sans Mono (SIL OFL). Fonts installed on the device are listed separately (Local Font
Access API) and are not recommendations.
