---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: deleting a chat removes what each app kept for it with one delete per app instead of one per stored key. A chat where an app kept 650,000 small keys took 24.6 s to delete and froze the page for up to 5.1 s. Now it takes about 3 s and the page never stops for more than a few milliseconds.
