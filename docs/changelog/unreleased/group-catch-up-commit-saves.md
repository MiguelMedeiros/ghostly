---
section: Fixed / Everywhere
---
- Back in a private group after many members joined and left, the app and the CLI save the group once a second while
  they catch up, not once for each change of members: 200 changes missed wrote about 41 MB, now under 1 MB.
