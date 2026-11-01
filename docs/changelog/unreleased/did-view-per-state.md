---
section: Fixed / Identities
---
- The app no longer rebuilds the profile's public DID document each time its state changes, only when what the document
  lists changes. That was most of the work in each state update of a profile with few chats.
