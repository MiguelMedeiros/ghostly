---
section: Fixed / Groups
release: 1.11
---
- In a private group that runs through hubs, a hub going offline or coming back no longer makes the other members save
  the group's whole membership history again. In a group of 31, two hubs that kept dropping out cost every other hub
  1.7 MB of writes in 30 minutes, and a hub closing cost each member it carried 57 to 115 KB; each change now writes
  a few hundred bytes.
