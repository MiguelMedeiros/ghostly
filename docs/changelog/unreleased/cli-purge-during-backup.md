---
section: Fixed / CLI
---
- `ghostly message delete --purge` run while a `ghostly profile backup` was reading the store answered `purged: true` with the message's text still in the profile's `db/rows.db`, kept there after the backup ended. It now answers once the backup has read the store, and then nothing of the text is left in the folder; the backup, taken before the delete, keeps it.
