---
section: Fixed / Everywhere
---
- In the browser extension, every update the open tabs got (a contact typing, a message arriving, a file moving) still carried every private group's connection to each of its members again, even when none of them changed. Now a member connection travels to a tab only when it changed: with three private groups of 32 members, a contact typing costs each tab about 7 KB instead of 152 KB.
