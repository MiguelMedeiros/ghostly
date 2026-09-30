---
section: For developers
---
- A release's `latest.json` is written only when every bundle's signature was made for the tagged version. Tauri 2.12 records the version in the signature, and the updater refuses an update whose manifest announces another one.
