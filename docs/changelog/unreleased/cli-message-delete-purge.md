---
section: For developers / CLI
---
- `ghostly message delete <chat|group> <message> --purge` takes what the message said out of the profile's folder before it answers (`purged: true`), the line of it that the replies quoting it kept too, and in a private group the copy of it the group kept with its last messages (for members who missed it), which its keys could still open. Without it, the text of a deleted message stays in the store's journal (`db/journal.bin`) until the store folds it, within the hour. Meant for a secret pasted into a chat (a token a bot saved, say); it rewrites the store's snapshot, so not for every delete. Over the socket: `chat.delete` with `purge: true`.
