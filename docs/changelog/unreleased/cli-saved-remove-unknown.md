---
section: Fixed / CLI
---
- `ghostly saved remove` with a mistyped message id now fails with `not_found` (exit 3) and points to `ghostly saved list`. Before, it answered done and the message you meant stayed saved. Unsaving a message whose own message was deleted still works, and unsaving one that was not saved stays quiet.
