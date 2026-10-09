---
section: Fixed / Groups
release: 1.2
---
- A file a group cannot take right now (more than 8 files sent to it within a minute, or you are no longer in the group) is refused at once in the app. Without this, the app first copied the whole file into its storage and checked it, up to 100 MB, and only then said no and deleted the copy.
