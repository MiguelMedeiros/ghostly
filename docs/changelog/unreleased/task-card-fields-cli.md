---
section: For developers / Headless CLI
---
- `ghostly task send` and `task update` take `--pr-state draft|open|merged|closed`, `--pr-checks passing|failing|pending`, `--tag <label>` (up to 3, 24 characters each) and `--parent <task>` (a task of yours in the same chat). They are optional card fields that apps from before them ignore, showing the card as before; no status was added.
