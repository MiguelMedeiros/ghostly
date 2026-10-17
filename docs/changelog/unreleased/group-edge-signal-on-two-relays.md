---
section: Fixed / Groups
---
- A private group's connection to a member no longer leaves its newest offer or answer on only one of the two relays when the other fails it or is busy: that relay gets it again soon after, so a member reading either relay finds the new offer. Before, a member reading the relay that missed it answered the old offer, or found none, and the connection waited for a later attempt, longer on a VPN.
