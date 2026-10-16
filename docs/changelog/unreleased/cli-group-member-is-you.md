---
section: Fixed / CLI
---
- A group command that names the profile itself (its own key or a prefix of it) in `group remove`, `group admin`, `group hub` or `--mention` now says `"<key>" is you: name another member of <group>` (bad_request). It answered not_found "No member <key> in <group>", as if the profile were not in the group.
