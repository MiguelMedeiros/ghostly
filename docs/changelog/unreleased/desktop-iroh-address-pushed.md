---
section: Fixed / Everywhere
---
- Desktop and Android: the app no longer asks itself every 5 seconds for the address of each chat's Iroh listener. It is told when the address changes (the listener reached its relay, the network changed), about a second after it does instead of up to five. With eight chats live over Iroh that was 96 questions a minute while nothing happened, for as long as the app ran.
