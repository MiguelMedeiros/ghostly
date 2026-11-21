---
section: Fixed / CLI
release: 1.14
---
- On a CLI profile (one device only), the engine's device calls that would add, remove, move or take over a device are refused (`refused`, exit 1) in one wording with `details.reason` `single_device`, and `deviceRemove` no longer asks for `--yes` first. `deviceEnrollReady` answers `single` instead of `ready`.
