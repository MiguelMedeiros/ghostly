---
section: For developers
---
- A batch of several pull requests no longer pays a full CI run on dev for its first pushes: each push but the last holds the tree of one of the batch's own commits, and now counts as tested by the batch's green run, as the last push already did.
