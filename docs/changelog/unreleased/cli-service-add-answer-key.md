---
section: Fixed / CLI
---
- `ghostly service add` now answers the service it made as `service`, the key `service share`, `service enable` and `service open` already use. The old `serviceId` key is still there beside it for one release, so scripts that read it keep working.
