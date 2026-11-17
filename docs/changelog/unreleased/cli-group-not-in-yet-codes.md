---
section: Fixed / CLI
release: 1.14
---
- A group you are not in yet answers `refused` to every command: `ghostly group send` said `unavailable`, and `group leave` `engine` (now refused before `--yes` is asked, as nothing is deleted). `ghostly group join` of a link to a group you are out of, or have an invitation to, is `refused` instead of `engine`, and an admin's `group leave` with nobody else online `unavailable` (try again once a member is) instead of `engine`, which a bot may take for the engine failing. The exit status stays 1.
