---
section: Fixed / Identities
---
- A contact's removed identity no longer stays Verified for up to 12 extra hours when your app starts offline or the relays don't answer. A lookup for removed identities that could not run is tried again within minutes, or as soon as you are back online, and only a lookup that got an answer counts toward the 12 hours. An identity you remove while offline is published as removed as soon as you are back online, not up to an hour later.
