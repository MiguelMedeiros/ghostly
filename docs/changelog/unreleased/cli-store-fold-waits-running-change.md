---
section: Fixed / CLI
---
- A change to a chat or a setting that was still being made when the store was folded, then undone (refused, or cancelled), no longer comes back after a restart. A daemon killed just after such a change no longer comes back with half of it. The fold now waits for the change to finish before it saves the store, and so does a backup.
