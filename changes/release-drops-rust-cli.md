---
section: Security / Everywhere
---
- **The Rust `ghostly-cli` binaries are no longer release downloads.** It takes a seed and a key on the command line, where other programs on the machine can read them. The CLI to use is `ghostly` (`packages/cli`). Bots still on the Rust client build it from `cli/` in the repository.
