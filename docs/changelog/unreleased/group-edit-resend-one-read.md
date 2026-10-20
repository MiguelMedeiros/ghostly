---
section: Fixed / Groups
---
- Starting the app with many edited messages of yours in a private group no longer reads the group's whole history again every 11 seconds for each member. The edits it says again to a member who just connected now come from one read per connection. Before, 7 members and 256 edits made 112 reads of a 10,000-message history, about 6 s of work.
