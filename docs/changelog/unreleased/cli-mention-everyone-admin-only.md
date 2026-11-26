---
section: Fixed / CLI
release: 1.14
---
- `group send --mention everyone` and `group edit --mention everyone` from a member who is not the private group's admin, or in a community (which has no @everyone), are refused (exit 1) and nothing is sent. They answered `sent: true` with no word while the app dropped the mention, so the message went out mentioning nobody.
