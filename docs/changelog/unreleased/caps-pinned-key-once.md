---
section: Fixed / Chat
---
- A chat's capability record no longer runs a key agreement (X25519) at every seal and every read once the contact is pinned: it is done once per contact and chat. Part of the work every start did for each saved chat (agents#1087).
