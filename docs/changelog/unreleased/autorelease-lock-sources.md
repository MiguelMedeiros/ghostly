---
section: For developers / CI
---
- The security autorelease gate refuses a lock file that keeps a dependency's name but takes it from somewhere else: an npm alias to another package, a download from another registry or a git repository, a workspace link turned into a download, or a crate off crates.io. Before, only new names were refused.
