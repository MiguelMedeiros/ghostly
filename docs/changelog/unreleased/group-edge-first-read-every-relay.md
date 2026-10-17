---
section: Fixed / Groups
---
- A group connection that starts again (after an app restart, or when a VPN made it switch transports) reads the other member from every relay at once and takes the newest offer. Before, it took the first relay's answer, which could be an old offer or nothing when that relay had refused or not yet received the new one, and it waited for its next look before it could connect.
