---
section: Fixed / CLI
---
- `ghostly group edit` and `ghostly message delete --everyone` in a group you are not in yet (an invitation, a knock at its link, or an invitation that was taken back) say so with the next step, as `group send` does, instead of "No message … in this group", as if the message id were mistyped. The exit code stays 3.
