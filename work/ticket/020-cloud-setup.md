# 020: Google Drive and OneDrive setup and real-service check

Status: waiting on owner (client IDs)
Raised: 2026-11-27

Drive and OneDrive storage locations are built and tested against fakes only. To turn them on, put the public client
IDs in `public/js/config.js` under `oauth`.

## Owner setup
1. **Google Cloud:** enable the Drive API; OAuth consent screen with scopes `drive.file` and `drive.appdata`
   (non-sensitive, so at most brand verification to leave Testing; please confirm in the console); OAuth client type
   "Web application", JavaScript origin `https://<user>.github.io`, redirect URI `https://<user>.github.io/<repo>/`
   (trailing slash). Optional for local use: `http://localhost:8080` and `http://localhost:8080/`.
2. **Azure (Microsoft Entra):** App registrations → New, personal + work/school accounts, platform "Single-page
   application", redirect URI `https://<user>.github.io/<repo>/`, no secret, delegated permission
   `Files.ReadWrite.AppFolder`.
3. `config.oauth.redirectUri` overrides the default redirect (the app URL without `index.html`).

## To check with the real services
- Popups under Google/Microsoft opener policies; the Google `prompt=none` iframe renewal.
- Drive search lag; OneDrive `/content` redirect CORS and download hosts; returned scopes.
- Whether work/school accounts support the OneDrive app folder.

## Follow-ups
- `folder.js`: after an "error" state the 30 s poll stops until the next edit or reconnect; retry "error" locations on
  the next poll (cloud errors are more common).
- Adding the same cloud folder twice is refused by name only.
- Tokens in IndexedDB are not encrypted with the PIN key.
- Optional CSP `<meta>` (GitHub Pages can't set headers): `default-src 'self'; script-src 'self'; connect-src 'self'
  https://www.googleapis.com https://graph.microsoft.com https://login.microsoftonline.com https://*.1drv.com
  https://*.sharepoint.com; frame-src https://accounts.google.com; img-src 'self' data: blob:; style-src 'self';
  font-src 'self'; object-src 'none'; base-uri 'self'` (download hosts to confirm).

## Owner decisions (2026-11-27)
- **CSP:** add the `<meta>` Content-Security-Policy now (hosts to confirm with real accounts).
- **Tokens:** encrypt stored sign-in tokens with the PIN key when the PIN lock is on; cloud sync pauses while locked.
- **Client IDs:** not yet; step-by-step below.

## Step by step: getting the two client IDs
The app URL on GitHub Pages is `https://<user>.github.io/<repo>/source/app/` (the repository root forwards there).
Use that exact URL (with the trailing slash) as the redirect URI below.

**Google Drive**
1. Open console.cloud.google.com, create a project (any name).
2. APIs & Services → Library → enable **Google Drive API**.
3. APIs & Services → OAuth consent screen: User type **External**, app name, your support email; scope
   `.../auth/drive.appdata`; add yourself under **Test users** (no Google verification needed while in Testing).
4. APIs & Services → Credentials → Create credentials → **OAuth client ID** → type **Web application**.
   - Authorised JavaScript origins: `https://<user>.github.io` (plus `http://localhost:8080` for local testing).
   - Authorised redirect URIs: the app URL above (plus `http://localhost:8080/`).
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). No client secret is used.

**OneDrive**
1. Open entra.microsoft.com → Applications → **App registrations** → New registration.
2. Supported account types: **Personal Microsoft accounts and work/school** (or personal only).
3. Redirect URI: platform **Single-page application (SPA)**, the app URL above (plus `http://localhost:8080/`).
4. API permissions → Add → Microsoft Graph → Delegated → `Files.ReadWrite.AppFolder` and `offline_access`.
5. Copy the **Application (client) ID** from Overview. No secret.

Then paste both IDs in chat (they are public) and they go into `source/app/js/config.js` under `oauth`.
