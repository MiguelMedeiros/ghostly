---
section: Fixed / Groups
---
- In a private group whose members are away, the app no longer signs a new relay packet for each member's connection
  every few seconds only for the relays to refuse it: with no member to pass it on and no relay taking it now, the packet
  waits unsigned until one can. A daemon in 10 groups with 3 members away signed about 80 such packets a minute.
