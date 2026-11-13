---
section: Fixed / CLI
---
- `ghostly react` and `ghostly group react` with something that is not one emoji (a word, two emoji) answer a usage error (exit 2) that names it, before the profile opens. Before, a command without a daemon opened the profile and went online first (about 1 s on a profile with many chats), then answered `bad_request` "A reaction is one emoji" (exit 1), unlike `status set --emoji`.
