---
section: Fixed / Groups
---
- Joining a private group by its link no longer stalls at "Let in: getting the group's keys" when the joiner or the admin is on a network that lets no direct connection through (a VPN, a firewall): the join goes on over Iroh's relay. A group's connections now recover on such a network too: when a VPN comes on with the group open, they go on over Iroh's relay as 1:1 chats do, and stay there instead of going back to direct connections that fail again. A CLI daemon's log now says each step of a join through a link (knock seen, entry session opening, welcome sent).
