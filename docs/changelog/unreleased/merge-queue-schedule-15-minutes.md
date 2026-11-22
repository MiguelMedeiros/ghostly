---
section: For developers / Tests
---
- The merge queue's schedule runs every 15 minutes instead of every 5. It is only a backstop: a `queue` label, CI ending and a push to the base still start the train at once, and a batch held for company still leaves at its time.
