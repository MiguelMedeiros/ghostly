---
section: For developers / CLI
---
- A long-lived CLI or headless profile no longer slows down as its history grows: writing over a stored row (a message's delivery mark, an edit, a reaction, a file's state) or deleting one costs the same whatever the store holds. Before, each of those walked every row of the store, about 170 ms at 10,000 messages and 500 ms at 40,000, so one long chat slowed every other chat of the profile.
