---
section: Fixed / Relays
---
- The push relay logs forwarded and failed pushes as one line per status or cause a minute (`forwarded 201 4120 more`), as it already did refusals, instead of a line per push: its log no longer grows with traffic. If you run your own push relay, update it from this release.
