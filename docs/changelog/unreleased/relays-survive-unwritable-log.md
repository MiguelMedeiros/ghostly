---
section: Fixed / Relays
---
- The push and HyperDHT relays keep running when their log can't be written, as when the program reading it stops or its disk is full: they say so once on stderr and drop the log lines instead of stopping at the next request. If you run your own push or HyperDHT relay, update it from this release.
