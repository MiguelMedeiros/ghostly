---
section: Fixed / Groups
---
- A message sent or received in a community no longer saves the group's whole membership history again. In a community
  of 250 that history was 130 KB written for every message, and it grew with each join and removal (420 KB after 300);
  each message now writes about 5 KB, however long the history.
