# Installation

Every download is on the latest GitHub release: **https://github.com/MiguelMedeiros/ghostly/releases/latest**

## Web app: nothing to install

Open **https://app.ghostly.tools** in any modern browser.

- **Install it as an app** and it opens in a window of its own, even offline, with other apps able to share into it:
  - Chrome, Edge or Brave (computer or Android): **Settings → Install** in Ghostly, or the install icon in the address bar (⋮, *Install app* on Android).
  - iPhone and iPad: in Safari, tap Share, then *Add to Home Screen*.
  - What installing adds (offline start, Share to Ghostly, `web+ghostly:` links, shortcuts, the unread badge): [WEB.md](WEB.md#install-it).
- Keys and wallets live in that browser. What a web page can and cannot do, and how to host it yourself: [WEB.md](WEB.md).
- **Self-hosted:** `docker compose -f infra/docker-compose.yml up -d` in a clone serves the web app on `localhost:8080` ([WEB.md](WEB.md#run-it)).

## Android

The Android app is the web app in a Trusted Web Activity: a small APK with its own icon that opens app.ghostly.tools full screen, with the web app's limits (no native Iroh, no direct HyperDHT). Releases attach it once its signing key is set up; until then, CI builds a debug APK to try it, never to publish. Details: [ANDROID.md](ANDROID.md). Installing the web app from Chrome, above, gives the same app today.

## Browser extension (Chrome, Brave, Edge)

**From the Chrome Web Store:** [Ghostly](https://chromewebstore.google.com/detail/ghostly/nbedaagicniejlmfcncndfjcejaidbcf). Chrome keeps it up to date. The store version can trail the GitHub release while a new one is in review.

**From the release zip** (the newest version, or a browser without store access):

1. Download [ghostly-browser-extension-1.1.0.zip](https://github.com/MiguelMedeiros/ghostly/releases/download/v1.1.0/ghostly-browser-extension-1.1.0.zip) from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest) and unzip it somewhere you will keep.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.

Chrome never updates an unpacked extension. Ghostly tells you when a new version is out; replace the folder's contents with the new zip and press the reload arrow on the extension's card. More in [BROWSER.md](BROWSER.md).

## Desktop app

Download from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest):

| Platform | File |
|---|---|
| macOS, Apple silicon | [Ghostly_1.1.0_aarch64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v1.1.0/Ghostly_1.1.0_aarch64.dmg) |
| macOS, Intel | [Ghostly_1.1.0_x64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v1.1.0/Ghostly_1.1.0_x64.dmg) |
| Windows x64, installer | [Ghostly_1.1.0_x64-setup.exe](https://github.com/MiguelMedeiros/ghostly/releases/download/v1.1.0/Ghostly_1.1.0_x64-setup.exe) |
| Windows x64, MSI | [Ghostly_1.1.0_x64_en-US.msi](https://github.com/MiguelMedeiros/ghostly/releases/download/v1.1.0/Ghostly_1.1.0_x64_en-US.msi) |
| Linux x64, AppImage | [Ghostly_1.1.0_amd64.AppImage](https://github.com/MiguelMedeiros/ghostly/releases/download/v1.1.0/Ghostly_1.1.0_amd64.AppImage) |
| Linux x64, Debian/Ubuntu | [Ghostly_1.1.0_amd64.deb](https://github.com/MiguelMedeiros/ghostly/releases/download/v1.1.0/Ghostly_1.1.0_amd64.deb) |

- **Updates.** The app offers a new release, downloads it, checks Ghostly's signature and restarts into it. On Linux that is the AppImage; a `.deb` install is sent to the download instead. The check runs only while **Settings, Updates** allows it, and nothing installs without your OK.
- **Linux has no WebRTC in its WebView** (WebKitGTK ships without it). Chats connect over Iroh, HyperDHT or the DHT, and calls run in the app itself, with GStreamer: the `.deb` and `.rpm` depend on its base and good plugins, and the AppImage carries them. If a plugin is missing, the call buttons name the package to install. Screen sharing is not available on Linux yet.
- **Linux microphones, cameras and speakers** are listed by GStreamer, for calls and for Settings → Audio & video (the microphone meter and the test sound run there too). Microphones and speakers come from GStreamer's PulseAudio plugin (`gstreamer1.0-pulseaudio`, which the `.deb` recommends) or PipeWire's (`gstreamer1.0-pipewire`). Without either, none is listed and calls use the system default.
- **Checksums.** Each release has `SHA256SUMS.txt` and its signature `SHA256SUMS.txt.asc`. Check a download with `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`.

## CLI

For a bot on today's Ghostly, use `ghostly` ([CLI.md](CLI.md)): the app's engine without a screen, in the same chats as the apps. Node 22.12 or newer. Install it with:

```bash
npm install -g @ghostlytools/cli
```

Or from a clone:

```bash
npm install && npm run build -w @ghostlytools/cli && npm pack -w @ghostlytools/cli
```

```bash
npm install -g ./ghostlytools-cli-*.tgz
```

The older Rust `ghostly-cli` was removed after 1.0: `ghostly` is the CLI.

## Your first chat

1. Open [app.ghostly.tools](https://app.ghostly.tools) or the Desktop app.
2. **New**, then copy the invite link (or show its QR code) and send it to a friend.
3. They open it, or paste it under **Join**. The chat goes live as soon as you find each other.

What a chat can do: [Features](FEATURES.md).

## Build from source

Requirements (what the release workflow uses):

- Node.js 22.12 or newer, and npm (the CLI workspace needs 22.12)
- Rust, stable toolchain
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On Debian/Ubuntu: `libwebkit2gtk-4.1-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev librsvg2-dev patchelf libssl-dev libgtk-3-dev libayatana-appindicator3-dev`. To call from a Linux build, also `gstreamer1.0-plugins-good` and `gstreamer1.0-pulseaudio` (the call check names what is missing).

```bash
git clone https://github.com/MiguelMedeiros/ghostly.git
cd ghostly
npm ci

npm run tauri dev        # Desktop, development
npm run tauri build      # Desktop, release bundles in target/release/bundle/

npm run dev -w @ghostly/web   # web app on http://localhost:5180
npm run build:web             # web app, static files in apps/web/dist
npm run build:extension       # extension, load apps/extension/dist unpacked
```

The Desktop build bundles the Node runtime that runs it, for HyperDHT (`tools/scripts/prepare-native-runtime.mjs` runs before `tauri build`). To run the web app in Docker instead, see [WEB.md](WEB.md#run-it).

Tests and the rest of the workflow: [Contributing](../.github/CONTRIBUTING.md) and [Testing](TESTING.md).

## Troubleshooting

**macOS: "Ghostly.app is damaged and can't be opened".** macOS quarantines apps downloaded outside the App Store. Clear the flag, then open the app again:

```bash
sudo xattr -cr /Applications/Ghostly.app
```

**macOS: no system notifications ("Move Ghostly to Applications").** macOS gives none to an app run from a temporary folder, such as a disk image or a download it moved aside. Drag Ghostly to Applications and open it from there.

**Linux: the call buttons are off and name a package.** Calls need GStreamer's base and good plugins. Install the package the tooltip names (usually `gstreamer1.0-plugins-good`) and restart the app. No microphone or speaker under Settings → Audio & video: install `gstreamer1.0-pulseaudio` (or `gstreamer1.0-pipewire`).

**Web app: no "Wake me while closed" in Settings → Notifications.** It shows only where the browser has Web Push: Chrome, Edge and Firefox, and on iPhone and iPad only the app added to the Home Screen, from iOS 16.4 ([WEB.md](WEB.md#install-it)). The desktop app and the extension run on their own and are never woken.

**Web app: a second tab only waits.** One tab runs the peer at a time: close the other one ([WEB.md](WEB.md#what-a-web-page-cannot-do)).

Something else? [Open an issue](https://github.com/MiguelMedeiros/ghostly/issues). For a vulnerability, never open an issue: follow [SECURITY.md](../.github/SECURITY.md).
