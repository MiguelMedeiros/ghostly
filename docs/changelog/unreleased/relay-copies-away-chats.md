---
section: Fixed / CLI
---
- A daemon with many contacts away now gets each chat's packet onto every relay within minutes. With 50 contacts away, the relays had the packets of 15 chats after 40 minutes: the background reads took every request the relays' budget freed, so a contact coming back on the web app or the extension (which read only the relays) found the daemon's packet from before its restart, or none.
