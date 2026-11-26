---
section: Fixed / Groups
---
- When several payments change in a row (a reconnect settling a few at once), the app no longer goes through every payment made in groups once per change to tell the group what changed: the changes that come while it waits are told in one go. With 3,000 payments in groups, 20 changes in a row took about 370 ms; now at most twice the work of one change, about 37 ms.
