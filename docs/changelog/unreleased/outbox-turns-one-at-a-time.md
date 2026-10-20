---
section: Fixed / Chats
---
- A long chat whose link dropped with hundreds of texts awaiting receipts no longer reads its whole history dozens of times at once: the outbox's turns run one at a time again, and one that hangs lets only the next one start. The CLI daemon's memory went past 1 GB for this, and a contact's daemon ran out of memory at 4 GB.
