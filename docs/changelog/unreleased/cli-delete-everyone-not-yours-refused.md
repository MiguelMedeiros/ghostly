---
section: Fixed / CLI
release: 1.14
---
- `ghostly message delete --everyone` on a contact's message (or another member's in a group) answers `refused` (exit 1), as `ghostly edit` refuses it, instead of `not_found` (exit 3), so one exit status handles "not yours" from both commands. A message that is not here, or one of yours deleted already, stays `not_found`.
