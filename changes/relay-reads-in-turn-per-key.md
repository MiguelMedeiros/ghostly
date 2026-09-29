---
section: Fixed / Everywhere
---
- A chat or group edge reads its contact's packet from the relays in turn, one after the other, so a relay that missed the contact's latest packet (an offer after a restart) is read at most once in a row. Before, one link could keep reading the same relay while the others' reads went to the other one, and a restarted member was reached 12 to 60 s late.
- The relay requests kept free for a chat that waits for its contact go back to the groups as soon as the chat is live. Before, they were kept for a minute, and a group member back after a restart could wait about 45 s more for one of its groups.
