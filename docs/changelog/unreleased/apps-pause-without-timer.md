---
section: Fixed / Apps
---
- Adding a store with many revoked apps no longer waits a third longer than its checks take: each short pause the page takes while it checks them cost at least 4 ms, about 2 seconds of 6 on a Linux computer for a store with 4096 revocations.
- Checking an app made of many small files no longer holds the page for up to 50 ms at once: the check now lets the page draw between files, as it already did inside large ones.
