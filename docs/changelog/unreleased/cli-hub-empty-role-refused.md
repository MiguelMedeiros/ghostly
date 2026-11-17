---
section: Fixed / CLI
release: 1.14
---
- Over the socket, `group.hub` with an empty `role` (an unset variable in a script) answers `bad_request` "role must be one of pin, exclude, auto" instead of reading it as left out and putting the member back to auto, which cleared a pin or an exclusion. A `role` left out is still auto, and `ghostly group hub` with `--pin`, `--exclude` or `--auto` is unchanged.
