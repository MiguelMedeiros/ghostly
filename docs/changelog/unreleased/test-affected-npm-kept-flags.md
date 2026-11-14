---
section: For developers / Tests
---
- `npm run test:affected --list` (without the `--`) stops with the command to type instead of starting the full run, Rust included: npm kept `--list`, `--no-e2e` and the other flags for itself and passed the script none.
