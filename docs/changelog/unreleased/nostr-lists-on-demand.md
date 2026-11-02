---
section: Fixed / Identities
---
- Your loaded Nostr follow list and a contact's loaded Nostr posts no longer travel in every update of the app's
  state, only their counts: the posts are read when the contact's Nostr card shows them. In the browser extension
  that was over 200 KB sent on each update at the limits (2,000 follows, 200 posts).
