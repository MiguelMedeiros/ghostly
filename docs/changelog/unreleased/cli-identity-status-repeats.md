---
section: Fixed / CLI
---
- `ghostly listen`: when a contact's identity proof comes back to a status it had before (verified, then unconfirmed, then verified again), the new `identity.status` has an id of its own, so a listener that dedupes by `id` no longer drops the latest change. `identity.received` and `identity.status` also carry `error`, why the proof is not verified, as `identity contact` shows it.
