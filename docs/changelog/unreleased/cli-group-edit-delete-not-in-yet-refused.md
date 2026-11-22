---
section: Fixed / CLI
release: 1.14
---
- `ghostly group edit` and `ghostly message delete --everyone` in a group you are not in yet (an invitation, a knock at its link, or an invitation that was taken back) are now `refused` (exit 1), as `group react` and `message pin` are. They answered `not_found` (exit 3), which reads as a mistyped message id.
