# 005: Android app that keeps data in a chosen folder

Status: open
Raised: 2026-11-27

Goal: use Denotation on Android with the workspace in a user-selected folder (not the app's private storage), so it
can be synced and backed up.

Options:
1. **Installed web app (PWA) in Chrome on Android.** Works with the existing folder provider if Chrome on Android
   supports `showDirectoryPicker()` (caniuse lists Chrome for Android 155). Zero native code; test on a device once
   GitHub Pages is live.
2. **Recommended as the dependable route: light loader APK.** Minimal Kotlin WebView app, no third-party libraries:
   bundles `public/` (offline) or loads the Pages URL; picks a folder with the Storage Access Framework
   (`ACTION_OPEN_DOCUMENT_TREE` + persistable URI permission); exposes read/write/list/remove to the page through a
   JS bridge, used as a new "Android folder" provider in `js/adapters/locations.js` (main/backup and `sync.js`
   reused). Built by a GitHub Actions workflow (Android SDK is toolchain, not an app dependency).
3. Wait for Google Drive / OneDrive providers (roadmap 3), which need no folder at all.

Caveat: Android's folder picker can't select folders inside the Google Drive or OneDrive apps; syncing a phone folder
needs a sync app (e.g. Syncthing, FolderSync) or option 3.

Open questions: build option 2 now or after trying option 1? Bundle the web app in the APK (offline, with an update
check) or load it from GitHub Pages (auto-updates, needs network the first time)?
