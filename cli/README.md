# ghostly-cli

A Rust compatibility client and library for bots and scripts: it sends and reads the v0.4 records
([WISP 402](../docs/wisps/402-legacy-chat.md)) over the Mainline DHT, with `ghost://` invites.

- Usage, every command and flag: [docs/CLI.md](../docs/CLI.md).
- Agent skill and bot examples: [SKILL.md](SKILL.md).

```bash
cargo build --manifest-path cli/Cargo.toml     # target/debug/ghostly-cli
cargo test --manifest-path cli/Cargo.toml
cargo install --path cli                       # not on crates.io: install from the checkout
```

Release binaries: `ghostly-cli-{macos-arm64,macos-x64,linux-x64,windows-x64.exe}` on the
[latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest).
