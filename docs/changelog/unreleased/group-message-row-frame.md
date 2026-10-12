---
section: For developers
---
- A private group's message from another member is stored with the frame it came in (`StoredMessage.frame`, on the group's newest 256 rows at most), ready to be handed on to a member who was away. The engine keeps it to itself: histories, pages of them and changes reach a page or the CLI without it. No new store and no database version change.
