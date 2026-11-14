---
section: Fixed / CLI
---
- `ghostly service open` of a contact's app that is already open here now answers `not_found` (exit 3) and closes its port once the contact no longer shares it (they took it back, removed it, or are not live). Before, it answered the old link with exit 0, and that port kept answering "This peer does not share that service." until `service close`.
