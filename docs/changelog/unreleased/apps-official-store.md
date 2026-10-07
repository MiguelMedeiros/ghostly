---
section: For developers / Apps
---
- The official store has a home: github.com/MiguelMedeiros/ghostly-store, a curated list of apps added by pull request, checked by CI with the Ghostly CLI and signed offline by the owner. Ghostly reads it from `raw.githubusercontent.com` once its public key is set; until then the default store stays off. `tools/scripts/store-keys.sh` makes the store key and Chess's publisher key on the owner's machine, publishes Chess and signs the first index, printing only public keys. How it works and how to submit an app: docs/APPS.md.
