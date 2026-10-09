---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: refreshing a store whose index has not changed (opening the Apps page, or Refresh) no longer checks its signature and every revocation in it again, which held the page for about a second with 1000 revocations. Only its expiry is taken again; a changed index is still checked whole.
