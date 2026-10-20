---
section: Fixed / Chat
---
- Deleting messages for everyone in a 1:1 chat writes less to disk. Each deletion now saves the chat once instead of twice. The contact's confirmations no longer force a disk sync each, and confirmations that arrive together are saved together. A CLI daemon deleting many messages wrote tens of MB for a few hundred deletions.
