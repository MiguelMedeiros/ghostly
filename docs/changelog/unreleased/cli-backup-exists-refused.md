---
section: Fixed / CLI
---
- `profile backup --out` naming a file that exists answers `refused` (exit 1), not `confirm` (exit 5), which says to pass a flag such as `--force` that backup does not take.
