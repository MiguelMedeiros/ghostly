---
section: Fixed / Everywhere
---
- A group's open members panel no longer draws itself again on every change elsewhere in the app. Each change, up to 20 a second while a file moves, worked out every member's row again: about 8 ms each in a test with 256 members in a community. Now it draws only when something it shows changes, and a member's "last seen" still moves on with the clock. In that test, 200 changes elsewhere caused no draws of the panel and took 0.4 ms each.
