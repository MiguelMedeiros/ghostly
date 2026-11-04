---
section: Fixed / Identities
---
- A profile with identities and many contacts who shared a Nostr identity no longer slows the app on every update. Each update, up to 20 a second while a file moves, counted again for every such chat how many chats each of your identities is shared in, so the work grew with the square of your chats: about 50 ms per update with 32 identities and 100 contacts. Now the chats are counted once per update, and a chat's Nostr view reads your keys directly. In a test with 5 identities and 11 chats, building your identities read each chat once instead of 5 times.
