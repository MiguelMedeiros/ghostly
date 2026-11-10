---
section: Fixed / CLI
release: 1.11
---
- `ghostly file send` of a file that changes while it is sent (a log still written to, a file being saved), to a chat or a group, now fails with `unavailable` naming the file: "<path> changed while it was being sent: send it again once nothing is writing to it", with `details.reason: file_changed` and `details.path`. It failed as `engine` with only "The blob could not be read". Nothing is kept either way.
