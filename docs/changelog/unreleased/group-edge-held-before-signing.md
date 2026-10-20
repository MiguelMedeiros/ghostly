---
section: Fixed / Groups
---
- A device in several private groups uses less CPU when the relays are busy. Each connection to a group member used to sign a new packet even when no relay would take it at that moment; it now checks first and tries again once the relays have room, as chats already did. On a CLI hub with 5 groups, about 8-10% of its CPU went to packets that never went out.
