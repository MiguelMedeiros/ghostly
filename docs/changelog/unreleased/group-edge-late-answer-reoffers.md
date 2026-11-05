---
section: Fixed / Groups
---
- After an app restarts, a group member whose answer to its WebRTC offer was read late (the relays' request limit held it back) is offered WebRTC again, instead of both apps moving that member's connection to Iroh or HyperDHT for the rest of the run, where it could stay unreachable for minutes.
