---
section: Fixed / Groups
---
- An app in private groups no longer checks the signature of each group packet it has just signed on its way to the relays, as 1:1 chats already did not: about 200 ms of CPU a minute for a member in 5 groups of 7 under traffic.
