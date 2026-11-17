---
section: Fixed / CLI
---
- A daemon killed just before its store's fold finished, or just after, no longer comes back with a change half there (a file's record back without its state, after a rename and then a delete). The new snapshot, already written whole, takes the old one's place at the next start, and the changes it holds are not written again after it.
