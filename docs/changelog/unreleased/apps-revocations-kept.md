---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: the update check no longer keeps every revocation a publisher ever served on the installed app's record. It keeps what the publisher serves now, plus the kept ones that stop the installed or the waiting version. While no `ghostly-revoke.json` answers, everything kept stays. Before, a publisher's file of 1000 revocations that changed between checks grew the record by about 350 KiB at every check.
