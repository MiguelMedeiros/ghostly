---
section: Fixed / Everywhere
---
- A chat or group edge reads its contact's packet from the relays in turn, one after the other, so a relay that missed the contact's latest packet (an offer after a restart) is read at most once in a row. Before, one link could keep reading the same relay while the others' reads went to the other one, and a restarted member was reached 12 to 60 s late.
