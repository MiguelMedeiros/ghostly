---
section: Fixed / CLI
---
- `ghostly group join` through a daemon now answers `"joined"` and `"stage"` too, at once, as they are when the link is opened: before, it answered only the group's id, so a script could not tell a group it was in from one it was still knocking at without a second `ghostly group show`. A link only kept beside a group under its id already held, or a group a contact already invited you to, now says so on stderr through a daemon as it does without one, with the next step.
