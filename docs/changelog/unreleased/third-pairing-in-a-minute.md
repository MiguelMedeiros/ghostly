---
section: Fixed / Chat
---
- Pairing several people one after another no longer stalls on the third: on relays that allow 30 requests a minute (self-hosted ones, pkarr.pubky.org), the third invite made within a minute took about 60 seconds to connect, against 3 to 5 for the others, because the inviter did not read the joiner's answer until a minute of requests had passed. It now reads an invite it has just made a few times past that limit, within the small allowance already kept for connecting chats.
