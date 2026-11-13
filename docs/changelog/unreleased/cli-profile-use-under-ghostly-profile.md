---
section: Fixed / CLI
---
- `ghostly profile use <name>` answers the profile the next commands run on, as `profile create --use` does: with `GHOSTLY_PROFILE` set to another profile it answered `{"current":"<name>"}` while every later command in that shell still ran on the other one. It now answers that profile and says on stderr that `GHOSTLY_PROFILE` still picks it.
