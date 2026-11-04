---
section: Fixed / Everywhere
---
- An open group no longer draws again on every change elsewhere in the app, as a 1:1 chat already did not. Each change, up to 20 a second while a file moves, drew the group's page and its connection icon again. Now they draw only when something they show changes, and a member's "last seen" in the connection list still moves on with the clock. In a test, 20 changes elsewhere caused no draws of the group; before, each one drew it.
