---
section: Fixed / Identities
---
- Loading a Nostr profile, follow list or notes checks each event's signature once, not once for every relay that sends it: with eight relays, Load notes did eight times the work.
