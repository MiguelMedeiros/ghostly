---
section: Fixed / CLI
---
- `ghostly app publish` refuses an app folder holding a private key written inside a JSON or JS string, its line breaks as `\n` (a cloud service account's `private_key`, a key pasted into code), as it refuses a key file: such a key went out in the public bundle.
