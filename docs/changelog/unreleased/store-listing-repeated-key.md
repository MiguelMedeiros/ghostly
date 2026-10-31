---
section: For developers
---
- A store's check of a submitted `listing.json` refuses a key written twice (`not-json`, naming the key). Before, the last value was taken silently, so a reviewer reading the file could see one digest or URL while the index was built from another.
