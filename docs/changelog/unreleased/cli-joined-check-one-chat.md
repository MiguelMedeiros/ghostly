---
section: Fixed / CLI
---
- A task, routine or usage card sent or updated, a `file send`, a `button update` and an edit, reaction or pin not confirmed yet no longer read the list of every chat to check whether someone joined that one chat: on a profile with 2,000 chats each card update spent about 23 ms of the daemon's time on it, and a one-shot `usage send` up to three times that.
