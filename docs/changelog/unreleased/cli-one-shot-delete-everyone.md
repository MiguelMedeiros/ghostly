---
section: Fixed / CLI
---
- `message delete <chat> <message> --everyone` without a daemon stays until the contact confirmed, as `edit` does, and answers `confirmed`. Before, it answered done and left, and the contact kept the message until a later command of this profile went live. `--wait none` and `--timeout` are new.
