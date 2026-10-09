---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: an app that sends ten times the broker's request rate (more than 500 messages within one second) is stopped; on the web its port is closed and its frame removed. Past 50 a second a request is still refused with `too-fast` (WISP 1200).
