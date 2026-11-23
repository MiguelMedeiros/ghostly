---
section: Fixed / Groups
---
- The chat list costs less while you are in large groups: it no longer copies every member of every group each time the app's state changes (several times a second while a file moves or links check in), only each group's member count and the names its reaction line may need. With 20 communities of 256 members, about 3 ms down to under 1 ms a change on a fast machine. A member made admin, or another change the list does not show, no longer redraws it.
