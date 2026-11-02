---
section: Fixed / Groups
---
- A message sent or received in a private group no longer saves the group's whole membership history again. In a group
  of 32 that history was 50 KB written for every message, and it grew with each join and leave (780 KB after 150);
  each message now writes about 14 KB at most, however long the history.
