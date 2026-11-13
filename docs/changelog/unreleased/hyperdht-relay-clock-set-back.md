---
section: Fixed / Relays
---
- The HyperDHT relay no longer drops every browser connected to it when the clock of the machine it runs on is set
  back (a time sync, an operator fixing a clock that ran ahead). After a one-hour step it stopped reading each browser
  at its next message for that hour, so the browser was dropped within a minute and all its chats went offline until it
  reconnected. If you run your own HyperDHT relay, update it from this release.
