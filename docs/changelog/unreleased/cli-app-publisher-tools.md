---
section: For developers / CLI
---
- `ghostly app publish`, `ghostly app verify`, `ghostly app revoke` and `ghostly store sign`, the publisher tools of WISP 1200 (Apps). `app publish <dir> --key <file>` bundles a folder into a signed `app.ghostlyapp` and raises its `sequence` by itself; `app verify` checks a bundle from a file or an https URL as the app will; `app revoke` adds a revocation signed by the app's own key to `ghostly-revoke.json`; `store sign` signs a store index into `ghostly-store.json` and `ghostly-store.sig`. Keys are files of their own, never a profile's, made owner-only and never printed. Apps do not run in Ghostly yet.
