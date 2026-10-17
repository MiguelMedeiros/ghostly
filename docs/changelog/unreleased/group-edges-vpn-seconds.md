---
section: Fixed / Everywhere
---
- A private group member whose network lets no direct connection through (a VPN, a firewall that drops UDP) reaches the other members over Iroh's relay a few seconds after a connection to them fails, as its 1:1 chats do. Before, each connection to a member waited for WebRTC to give up first, 15 seconds to a minute and a half, so a member who turned a VPN on had its group messages held all that while.
