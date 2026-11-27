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
