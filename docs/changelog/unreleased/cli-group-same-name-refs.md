---
section: Fixed / CLI
---
- When two members of a group share a name, `ghostly group send --mention`, `group edit --mention`, `group remove`, `group admin` and `group hub` now name each of them with the start of its key, say to use the key, and point to `ghostly group show <group>`, with each one's `key` and `name` in `details.matches`. They answered only that the name fits more than one member. The error code (`bad_request`) and exit status (1) are unchanged.
- `--mention` of your own name now says it is you (`bad_request`, exit 1), as `group remove` and a mention of your own key do, instead of saying no member has that name (`not_found`, exit 3). A name no member has now points to `ghostly group show <group>`.
- `ghostly group pin`, `group unpin` and `group members` now name the command that does it (`ghostly pin <group> <message>`, `pin <group> --remove`, `group show <group>`) and its help, instead of listing the group commands only. The error code (`usage`) and exit status (2) are unchanged.
