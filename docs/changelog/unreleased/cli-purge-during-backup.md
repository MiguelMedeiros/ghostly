---
section: Fixed / CLI
---
- `ghostly message delete --purge` run while a `ghostly profile backup` was reading the store answered `purged: true` with the message's text still in the profile's `db/rows.db`, kept there after the backup ended. It now answers once the backup has read the store, with rows.db and the store's journal free of the text. What the backup read, from before the delete, still holds it: its copy of the store in `db/` until the backup ends, and the backup itself.
