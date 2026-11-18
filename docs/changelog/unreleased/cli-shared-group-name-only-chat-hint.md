---
section: Fixed / CLI
---
- `call start`, `chat verify`, `group auto on --from` and the other commands that take only a 1:1 chat, given a name more than one group has, now say why they take a chat ("a call goes to a contact, in their chat", "only a chat has a code to compare", "--from takes the chats whose invitations it accepts") and point at `ghostly chat list`. They said "a group command takes one by its id", which named no command, and none of them has a group twin. The error code and exit status are unchanged.
