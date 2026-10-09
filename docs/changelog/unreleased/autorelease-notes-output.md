---
section: For developers / CI
---
- The security autorelease gate hands the release notes to the next jobs inside a block whose end marker is random per run, so a line in a branch's changelog can no longer end the notes early and set the version that gets tagged and released after the gate checked it.
