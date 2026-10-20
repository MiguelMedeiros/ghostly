---
section: Fixed / Groups
---
- Large community groups no longer slow the whole app down: each update of the app's state hashed every group's newest membership change again for each member, about 5,000 hashes per update with 10 groups of 256 members. It is now hashed once for each change.
