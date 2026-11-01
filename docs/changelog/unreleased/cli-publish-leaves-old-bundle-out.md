---
section: Fixed / CLI
---
- `ghostly app publish --out <file>` no longer puts the `app.ghostlyapp` an earlier publish left in the app's folder into the new bundle. Before, the previous version went out inside the new one as one of its files, doubling its size and publishing whatever that version held.
