---
section: Fixed / CLI
---
- `ghostly task update --steps 4/5` on a card that had `--progress 90` now shows 80% from the steps, and `--progress` after `--steps` drops the old steps: before, the card kept both and showed "90% · 4 of 5 steps", its bar at the old percent.
