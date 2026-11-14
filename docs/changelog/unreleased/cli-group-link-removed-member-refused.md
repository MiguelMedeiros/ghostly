---
section: Fixed / CLI
---
- `ghostly group link` run by a member removed from a group (or who left it) is refused, as `group send` is ("You were removed from this group"). It answered the link held when they were removed, with exit 0, though `group show` said `link: null` and the admin may have reset it or turned it off since.
