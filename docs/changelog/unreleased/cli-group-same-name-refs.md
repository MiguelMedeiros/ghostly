---
section: Fixed / CLI
---
- When two members of a group share a name, `ghostly group send --mention`, `group edit --mention`, `group remove`, `group admin` and `group hub` now name each of them with the start of its key, say to use the key, and point to `ghostly group show <group>`, with each one's `key` and `name` in `details.matches`. They answered only that the name fits more than one member. The error code (`bad_request`) and exit status (1) are unchanged.
- `--mention` of your own name now says it is you (`bad_request`, exit 1), as `group remove` and a mention of your own key do, instead of saying no member has that name (`not_found`, exit 3). A name no member has now points to `ghostly group show <group>`.
