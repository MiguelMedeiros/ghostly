---
section: Fixed / CLI
---
- The event stream no longer misses a group's join, leave or rename line that reaches this device more than 30 days after it happened (a member back after a month away), nor a contact's edit of an old message when their clock is a month or more behind. Both were taken for old history and gave no `group.event` or `message.edited`. The engine now keeps when such a line or edit came to this device, and the 30-day rule counts from that.
