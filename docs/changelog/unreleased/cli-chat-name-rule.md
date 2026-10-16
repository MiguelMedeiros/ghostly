---
section: Fixed / CLI
---
- A chat's name given to `ghostly chat rename`, `invite create --label` or `invite join --label` is refused with the rule (`bad_request`, "A chat's name is up to 48 characters on one line"), before any invite is made, instead of being cut at 48 without a word. A cut through an emoji left half of it in the name, and a newline or a tab was kept.
