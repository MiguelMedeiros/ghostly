---
section: Fixed / CLI
---
- `group remove` on a group whose link is on says on stderr that the member can still join again with the link, and that `group link <group> --reset` keeps them out, as the app's Remove dialog does. Before, nothing said so, and a member removed by a script could come straight back. The JSON answer is the same.
