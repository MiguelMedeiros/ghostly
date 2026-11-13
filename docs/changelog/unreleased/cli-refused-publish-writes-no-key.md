---
section: Fixed / CLI
---
- `ghostly app publish` and `ghostly store sign` refused after the key step (a source without `kind`, a private key left in the app's folder, an index a client refuses) no longer leave a new key file behind. Before, the next run, once the folder or the index was fixed, read that file as an existing key: `keyCreated: false`, and no "new … key written to …; back it up" note. The key is now written only with the bundle or the index it signs, so the run that writes it says so.
