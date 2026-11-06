---
section: For developers / CLI
---
- `group show` and `group list` have a new optional `others` field: the other invitations kept under the same group id
  (a contact's invite as `{chat, name, members}`, a group link as `{link}`, hidden without `--show-secret`). Pick one
  with `engine keepGroup` / `engine switchGroup`. `group auto` accepts only the invitation from the chat it was set up
  for.
