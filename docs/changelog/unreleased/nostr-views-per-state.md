---
section: Fixed / Identities
---
- A contact's loaded Nostr follows and posts are no longer compared and filtered again each time the app's state
  changes, only when one of those lists or your mute lists changes. Up to 9 ms per such contact on each state update.
