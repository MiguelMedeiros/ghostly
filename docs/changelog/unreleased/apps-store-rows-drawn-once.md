---
section: Fixed / Apps
---
- The Apps page no longer draws every open store's listings again when nothing in them changed: when the update check ends, for each Refresh's message and when that message closes. Show more draws only the listings it adds. With three open stores showing 50 apps each, each of those took 15 to 35 ms in tests and now draws nothing.
