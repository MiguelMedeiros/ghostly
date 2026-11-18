---
section: Fixed / CLI
---
- A community member's `group link` while the admin has the link off now says so, in the app's words: the link is off and only the admin can make a new one. It said "Only the admin can replace or turn off the group's link", which the member had not asked.
- A link join not let in yet: `group show` and `group list` give its `invitation` a `note` that says it knocks at the link and that `ghostly group decline <group>` stops it, and `group join` through a daemon adds a `warning` naming `ghostly group show <group>` to follow it. Nothing said so, and `status: "invited"` read as an invitation nobody sent.
- `group link`'s help says it prints the link and that anyone who has it can join; `group create`'s says the same of a community.
