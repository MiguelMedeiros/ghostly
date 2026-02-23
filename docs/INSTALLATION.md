# Installation

## Desktop Apps

| Platform | Architecture | Download |
|----------|--------------|----------|
| **macOS** | Apple Silicon (M1/M2/M3) | [Ghostly_aarch64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_aarch64.dmg) |
| **macOS** | Intel (x64) | [Ghostly_x64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_x64.dmg) |
| **Windows** | x64 (Installer) | [Ghostly_x64-setup.exe](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_x64-setup.exe) |
| **Windows** | x64 (MSI) | [Ghostly_x64.msi](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_x64_en-US.msi) |
| **Linux** | x64 (AppImage) | [Ghostly_amd64.AppImage](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_amd64.AppImage) |
| **Linux** | x64 (Debian/Ubuntu) | [Ghostly_amd64.deb](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/Ghostly_0.1.2_amd64.deb) |

## CLI (Command Line)

| Platform | Download |
|----------|----------|
| **macOS** (Apple Silicon) | [ghostly-cli-macos-arm64](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/ghostly-cli-macos-arm64) |
| **macOS** (Intel) | [ghostly-cli-macos-x64](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/ghostly-cli-macos-x64) |
| **Linux** (x64) | [ghostly-cli-linux-x64](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/ghostly-cli-linux-x64) |
| **Windows** (x64) | [ghostly-cli-windows-x64.exe](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.3/ghostly-cli-windows-x64.exe) |

Or install via Cargo:

```bash
cargo install ghostly-cli
```

## Build from Source

Prefer to summon your own ghost? Here's how:

```bash
# Clone the haunted repository
git clone https://github.com/MiguelMedeiros/ghostly.git
cd ghostly

# Install dependencies
npm install

# Summon the ghost (development)
npm run tauri dev

# Build for production
npm run tauri build
```

### Requirements

- Node.js 18+
- Rust 1.70+
- [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)

> 💡 **Tip:** The built app will be in `src-tauri/target/release/bundle/`
