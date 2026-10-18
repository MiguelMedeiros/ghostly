---
section: Fixed / Chat
---
- The cards under a message (a Pubky key or a DID, a Nostr profile or note, a group's link) are drawn again only when what they show changes. Before, each was drawn again on every change in the app, up to 20 times a second while a file moved: with 40 of them in a chat, 38 ms of work each time, now none.
