---
section: Fixed / CLI
release: 1.14
---
- `group remove`, `group admin`, `group rotate` and a private group's `group hub` from a member who is not the admin are now refused at once, in words that say what only the admin does ("Only the admin can hand the admin role over"). Before, `group admin <group> <name>` told them to use the member's key, `group remove <group> <a name nobody has>` that there is no such member, and only then was the command refused, in a community as just "Only the admin can do that".
