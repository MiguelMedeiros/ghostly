---
section: Fixed / Groups
---
- An app back after a restart sends each chat's and group's offer in its first packet, instead of a packet saying it is back and then the offer. With two groups and two chats that is 8 relay requests at start instead of 14, and more of the relays' minute is left to read the answers: back after a restart the others noticed 30 s later, it was live after 35 s instead of 43 to 93 s.
