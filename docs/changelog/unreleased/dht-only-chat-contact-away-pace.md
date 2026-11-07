---
section: Fixed / Everywhere
---
- A chat set to DHT only whose contact is away (nothing heard from it in 10 minutes) checks for new texts every 30 seconds, in its turn with the other chats, instead of every 4 seconds for as long as the app runs. A daemon with 50 such chats looked its contacts up on the Mainline DHT about 1,000 times a minute; it now makes none while its relays answer. The chat on screen, a text of yours waiting for its receipt, and a contact who is there still check every 4 seconds, and a contact coming back is seen at the next check.
