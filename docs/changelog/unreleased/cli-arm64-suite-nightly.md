---
section: For developers / Tests
---
- CI's "CLI on Linux ARM64" job packs and installs the CLI and starts its daemon with WebRTC and calls, without running the CLI's whole suite again (the packages shards run it on x64). The suite runs on arm64 nightly on `dev` (`cli-arm64-nightly.yml`), and a red night opens an issue or comments on the one still open.
