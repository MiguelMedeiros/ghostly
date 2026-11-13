---
section: Fixed / CLI
---
- `ghostly send`, `group send` and `file send` with an empty `--reply` (an unset variable, `--reply "$ID"`), and `ghostly button update` with an empty `--chosen`, are a usage error (exit 2) before the profile opens. Before, `--reply ""` sent a plain message and `button update --close --chosen ""` closed the buttons with no answer shown, both exit 0.
