---
section: Fixed / Relays
---
- The push relay no longer turns away a sender or a subscription for as long as the clock of the machine it runs on
  was set back (a time sync, a resumed virtual machine). One that had used its 30 requests a minute just before was
  refused until the clock caught up again, an hour after a one-hour step. If you run your own push relay, update it
  from this release.
