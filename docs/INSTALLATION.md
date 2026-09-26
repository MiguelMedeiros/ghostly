# Installation

Every download is on the latest GitHub release: **https://github.com/MiguelMedeiros/ghostly/releases/latest**

## Web app: nothing to install

Open **https://app.ghostly.tools** in any modern browser.

- On a phone, add it to the home screen (Share, *Add to Home Screen* on iOS; ⋮, *Install app* on Android) and it opens like an app.
- Keys and wallets live in that browser. What a web page can and cannot do, and how to host it yourself: [WEB.md](WEB.md).

## Browser extension (Chrome, Brave, Edge)

**From the Chrome Web Store:** [Ghostly](https://chromewebstore.google.com/detail/ghostly/nbedaagicniejlmfcncndfjcejaidbcf). Chrome keeps it up to date. The store version can trail the GitHub release while a new one is in review.

**From the release zip** (the newest version, or a browser without store access):

1. Download [ghostly-browser-extension-0.4.0.zip](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.4.0/ghostly-browser-extension-0.4.0.zip) from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest) and unzip it somewhere you will keep.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.

Chrome never updates an unpacked extension. Ghostly tells you when a new version is out; replace the folder's contents with the new zip and press the reload arrow on the extension's card. More in [BROWSER.md](BROWSER.md).

## Desktop app

Download from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest):

| Platform | File |
|---|---|
| macOS, Apple silicon | [Ghostly_0.4.0_aarch64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.4.0/Ghostly_0.4.0_aarch64.dmg) |
| macOS, Intel | [Ghostly_0.4.0_x64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.4.0/Ghostly_0.4.0_x64.dmg) |
| Windows x64, installer | [Ghostly_0.4.0_x64-setup.exe](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.4.0/Ghostly_0.4.0_x64-setup.exe) |
| Windows x64, MSI | [Ghostly_0.4.0_x64_en-US.msi](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.4.0/Ghostly_0.4.0_x64_en-US.msi) |
| Linux x64, AppImage | [Ghostly_0.4.0_amd64.AppImage](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.4.0/Ghostly_0.4.0_amd64.AppImage) |
| Linux x64, Debian/Ubuntu | [Ghostly_0.4.0_amd64.deb](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.4.0/Ghostly_0.4.0_amd64.deb) |

- **Updates.** The app offers a new release, downloads it, checks Ghostly's signature and restarts into it. On Linux that is the AppImage; a `.deb` install is sent to the download instead. The check runs only while **Settings, Updates** allows it, and nothing installs without your OK.
- **Linux has no calls and no WebRTC** (WebKitGTK ships without it). Chats connect over Iroh, HyperDHT or the DHT.
- **Checksums.** Each release has `SHA256SUMS.txt` and its signature `SHA256SUMS.txt.asc`. Check a download with `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`.

## CLI

`ghostly-cli` is a compatibility client for bots and scripts ([CLI.md](CLI.md)). It is not on crates.io.

| Platform | Download |
|---|---|
| macOS, Apple silicon | [ghostly-cli-macos-arm64](https://github.com/MiguelMedeiros/ghostly/releases/latest/download/ghostly-cli-macos-arm64) |
| macOS, Intel | [ghostly-cli-macos-x64](https://github.com/MiguelMedeiros/ghostly/releases/latest/download/ghostly-cli-macos-x64) |
| Linux x64 | [ghostly-cli-linux-x64](https://github.com/MiguelMedeiros/ghostly/releases/latest/download/ghostly-cli-linux-x64) |
| Windows x64 | [ghostly-cli-windows-x64.exe](https://github.com/MiguelMedeiros/ghostly/releases/latest/download/ghostly-cli-windows-x64.exe) |

Or build it from a clone:

```bash
cargo install --path cli
```

## Build from source

Requirements (what the release workflow uses):

- Node.js 22 and npm
- Rust, stable toolchain
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On Debian/Ubuntu: `libwebkit2gtk-4.1-dev librsvg2-dev patchelf libssl-dev libgtk-3-dev libayatana-appindicator3-dev`

```bash
git clone https://github.com/MiguelMedeiros/ghostly.git
cd ghostly
npm ci

npm run tauri dev        # Desktop, development
npm run tauri build      # Desktop, release bundles in target/release/bundle/

npm run dev -w @ghostly/web   # web app on http://localhost:5180
npm run build:web             # web app, static files in web/dist
npm run build:extension       # extension, load extension/dist unpacked
```

The Desktop build bundles the Node runtime that runs it, for HyperDHT (`scripts/prepare-native-runtime.mjs` runs before `tauri build`). To run the web app in Docker instead, see [WEB.md](WEB.md#run-it).
