# 006: Encrypted files, unlocked with the PIN

Status: resolved (built; see commit "Optional encryption")
Raised: 2026-11-27

Goal: an option to keep the workspace files (storage locations, main and backups) encrypted, so they're readable only
after unlocking. Turning encryption off must decrypt everything safely.

Default plan (in-house WebCrypto, no packages):
- **Envelope keys.** One random 256-bit data key encrypts each file (AES-GCM, fresh IV per write, file header with
  magic + version so encrypted and plain files are told apart). The data key is wrapped by:
  - a **passphrase** (PBKDF2-SHA256, high iteration count, random salt), stored as `keys.json` in the folder so other
    devices can open it;
  - a **recovery key** shown once when encryption is turned on;
  - on this device, the **PIN** (quick unlock), held in IndexedDB.
- **Turning it on / off** is a resumable job: a `denotation.json` marker (`encrypting` / `decrypting`) plus per-file
  headers, each file rewritten via temp + rename and verified by reading it back, the key kept until every file is
  plain. Interrupted jobs resume on the next unlock. Offer an export first.
- Folder names, file names and record ids stay visible; contents (titles, text, rows) are encrypted.

Caveats:
- A 4–6 digit PIN alone is a weak encryption key (1 million guesses, fast offline). That's why the folder copy is
  wrapped by a passphrase and the PIN only unlocks this device.
- Lose the passphrase and the recovery key, and the files can't be recovered.
- The AI (MCP) server can't read encrypted files unless given the passphrase (e.g. an env variable); off by default.
- The browser cache (localStorage) stays plain on this device, behind the PIN lock only.

Open questions: PIN-only (simpler, weak) instead of passphrase + PIN? Also encrypt the browser cache? Also encrypt
exports (ZIP/JSON)?

## Decisions (owner)

- **PIN only.** The data key is wrapped by a key derived from the PIN (PBKDF2, high iterations, salt); no passphrase.
  A recovery key is still shown once (it's the only way back if the PIN is forgotten). Weakness accepted and stated in
  the UI: anyone with the files can try all PINs offline.
- **Browser copy:** encrypt it too, only when toggled on (default off).
- **Exports:** off by default; optional password on ZIP exports using standard ZIP AES-256 (WinZip AE-2: opens in
  7-Zip, WinRAR, macOS Archive Utility/Keka; Windows Explorer may not). Built in house with WebCrypto.
- **Recovery key:** shown once when encryption is turned on. Plus an optional **Keep recovery key in the app**
  toggle: when on (and the dialog is closed), the key is stored wrapped by the data key and can be viewed in
  Settings → Security whenever the app is unlocked. Off by default.

## Follow-ups
- Done: `bumpManifest` keeps unknown manifest fields (older app versions could still strip them; update every device).
- Not yet tried in real 7-Zip / WinRAR / Keka / Archive Utility (checked against an independent implementation only).
- Optional `DENOTATION_PIN` for the MCP server.
