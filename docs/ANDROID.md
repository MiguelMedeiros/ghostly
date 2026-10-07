# Ghostly on Android

The Android app is [Ghostly on the web](WEB.md) (app.ghostly.tools) in a Trusted Web Activity (TWA): a small APK that opens the site full screen in the phone's browser engine, with its own launcher icon, task and splash screen. It is built with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) from `apps/android-twa/twa-manifest.json`.

It is the web app, so it has the web app's limits, not the Desktop's:

- No native Iroh and no direct HyperDHT: contacts are reached over WebRTC, or Iroh and HyperDHT through a relay ([WEB.md](WEB.md)).
- The peer runs only while the app is open, and sharing a local web app does not work ([What a web page cannot do](WEB.md#what-a-web-page-cannot-do)).
- Its data lives in the browser's storage for app.ghostly.tools, shared with that browser's tab of the site. Clearing the browser's site data clears Ghostly's too.
- It needs a browser that runs TWAs (Chrome, and others built on it). With none, it opens the site in a Custom Tab, with a URL bar.

What the web app already has comes along: sharing into Ghostly from other apps (the share target), notifications (web push), `web+ghostly:` links and the launcher shortcuts (New chat, Scan invite, Wallets). There is no Play Billing and no location delegation.

## Build it

CI builds it: Actions > Android > Run workflow builds an APK from any branch and attaches it to the run as the `android` artifact (the step summary gives its size). A pull request that changes `apps/android-twa/` builds it too, and every release builds it (`release.yml`).

Without the upload key (below), it is a debug APK signed with the Android debug key: install it to try the app (`adb install ghostly-<version>-android-debug.apk`), never publish it. With the key, it is a release APK signed with it, and releases attach that one.

Locally, with Node, a JDK 17 and the Android SDK (`platforms;android-36` and `build-tools;36.0.0`):

```bash
export JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk
apps/android-twa/build.sh            # debug APK in apps/android-twa/build/
```

`build.sh release` signs with the key in `ANDROID_KEYSTORE` (a file), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. The version is the repository's (`package.json`), and the version code is `major * 1000000 + minor * 1000 + patch`, so each release installs over the last. Icons and the web manifest are read from this checkout (`apps/web/public`), and the launcher icon is the Desktop's Android one (`apps/desktop/icons/android`). The script runs Bubblewrap's `update` itself; `bubblewrap build` is not used, so the `signingKey` block in the manifest is only a name.

## One-time setup (Miguel)

The app opens without a URL bar only once app.ghostly.tools vouches for the key the APK is signed with. Until then, it shows the URL bar. These steps need the key, so only Miguel can do them:

1. Make the upload key on your own machine, and keep it (and its passwords) somewhere safe outside the repository. Losing it means a new app for everyone who installed this one.

   ```bash
   keytool -genkeypair -v -keystore ghostly-upload.keystore -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Add four secrets to the repository (Settings > Secrets and variables > Actions):

   - `ANDROID_KEYSTORE_B64`: the keystore in base64 (`base64 -i ghostly-upload.keystore | pbcopy` on macOS)
   - `ANDROID_KEYSTORE_PASSWORD`: the keystore's password
   - `ANDROID_KEY_ALIAS`: `upload`
   - `ANDROID_KEY_PASSWORD`: the key's password (the same as the keystore's unless you chose another)

3. Put the key's SHA-256 fingerprint in `apps/android-twa/twa-manifest.json`. It is public, not a secret:

   ```bash
   keytool -list -v -keystore ghostly-upload.keystore -alias upload | grep SHA256
   ```

   ```json
   "fingerprints": [{ "name": "upload", "value": "AB:CD:...:EF" }]
   ```

   (or `npx @bubblewrap/cli@1.25.0 fingerprint add <fingerprint> --manifest=apps/android-twa/twa-manifest.json`). Merge it, and deploy the web app: its build writes `/.well-known/assetlinks.json` from that list (`apps/web/assetlinks.ts`), and nginx serves it as `application/json`. While the list is empty, the site serves no such file at all. A fingerprint that is not 32 hex pairs stops the web build. If the app is ever on Google Play with Play App Signing, add Google's app signing key fingerprint to the list too.

4. Check it: `curl -i https://app.ghostly.tools/.well-known/assetlinks.json`, then open the release APK on a phone. The URL bar should be gone.

## F-Droid

A TWA runs inside a browser the phone already has, so it needs one that supports TWAs. F-Droid's inclusion policy on TWAs and wrapper apps has not been checked yet: read it before submitting, as the app may not qualify or may need changes (for example the Google Play Services dependency some Bubblewrap features add).

## The native app (in progress)

A native Android app is being built to replace the TWA: the Desktop app (`apps/desktop`) built with Tauri 2 for Android, so the same UI and engine as Desktop, with native Iroh and direct Mainline DHT reads in Rust. It is not released. Package id `tools.ghostly.app` (the TWA's), Android 8.0 (API 26) and up.

### Build it

CI builds it: Actions > Android native (`.github/workflows/android-native.yml`), by hand or on a pull request that touches `apps/desktop/`. Each run has two debug APKs, signed with the Android debug key, to try and never to publish:

- `ghostly-android-debug-arm64-v8a`: phones, and an arm64 emulator on a Mac.
- `ghostly-android-debug-x86_64`: the CI emulator.

The run then installs the x86_64 APK on an Android 15 emulator and runs `tools/scripts/android-smoke.mjs` (Playwright over adb, inside the app's WebView): it launches, the UI renders, the engine starts, and the measurements below. The table is in the job summary; screenshots, logcat and the app's log are in the `android-smoke` artifact.

Locally, with the Android SDK, NDK 27.3 and a JDK 17: `npm run tauri -- android build --debug --apk --target aarch64`. The Gradle project is `apps/desktop/gen/android` (generated by `tauri android init`, then edited: keep the edits when regenerating). `rustup target add aarch64-linux-android` and `cargo check --target aarch64-linux-android -p ghostly --lib` (with the NDK's clang as `CC_aarch64_linux_android` and linker) check the Rust alone.

What is left out on Android, and why (`#[cfg(desktop)]`, refusing stubs in `apps/desktop/src/mobile.rs`): HyperDHT (a Node program; native HyperDHT through Bare is its own piece of work), the updater and the clipboard crate (no Android support), keep awake, the macOS share sheet, and the windows of shared and installed apps (a mobile app has one window). Opening a link or a sign-in page from Rust fails for now: the Android host brings the system's opener.

CI keeps the Android debug key the Gradle plugin makes (an Actions cache), so a newer debug APK installs over an older one. When that cache is gone (7 days unused, or another branch), Android refuses the update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`): uninstall the old one first.

A debug build started with `adb shell am start -n tools.ghostly.app/.MainActivity --ez ghostly_e2e true` runs as under an e2e suite (no name step, never a new profile's default Mainnet wallets). A release build ignores the extra.

### What the emulator measured (A0, October 2026)

Android 15 (API 35) x86_64 emulator on a CI runner, debug build. The emulator image's WebView is Chrome 124; a phone's WebView updates from the Play Store and is newer.

| What | Works | Measured |
|---|---|---|
| App starts, UI renders | Yes | Activity up in about 3 s, "New chat" on screen about 9 s after launch |
| Engine starts with the Desktop host | Yes | Settings shows "Mainline DHT (BEP44), Direct UDP" (Rust's Pkarr client) |
| Native Iroh endpoint | Yes | Binds in 0.1 to 0.6 s, gets its n0 relay and public address, a second endpoint connects to it in 25 to 175 ms |
| Netlink (Iroh's netwatch) | Partly | Android denies reading the routing table (`nlmsg_readpriv`, 3 SELinux denials per start); Iroh still finds its addresses. Network changes may be noticed late |
| Pkarr over UDP (Mainline DHT, no relay) | Yes | Write 2.9 to 3.6 s, read back 0.08 to 0.13 s |
| One publish, every source (the app's own log) | Yes, slow | DHT ok at 3.1 to 5.0 s; pkarr.pubky.app and pkarr.pubky.org ok at 4.0 to 7.1 s. A publish counts as written at its first ok (3.1 to 5.5 s) |
| HTTPS from Rust (relays, link previews, push) | Yes, after a fix | `rustls-platform-verifier` panicked until it was given the JVM (`android_tls` in `lib.rs`; its Kotlin half is the `.aar` in the crate, added by `gen/android/app/build.gradle.kts`); relay writes then "ok". A first GET to a relay takes 1.1 to 1.2 s (TLS and Android's certificate check), later ones 0.18 s, so the relays' 4 to 7 s is their own answer |
| WebRTC in the WebView | Yes | `RTCPeerConnection`, a data channel and host ICE candidates; `getUserMedia` present, microphone and speaker listed. `navigator.permissions.query` for microphone or camera throws |
| WebCrypto Ed25519 and X25519 | No on Chrome 124 | "Unrecognized name". Chrome shipped both in 137, so a phone with an updated WebView should have them; older WebViews need the fallback (a Keystore-sealed seed, A3) |
| Files over IPC | Yes, after a fix | Android's IPC goes through `postMessage` (its WebView cannot read a request body), so bytes arrive as a JSON array; `file_bytes_append` accepts that now. Slow for big files |
| `ghostly-file` scheme | Yes, after a fix | Served at `http://ghostly-file.localhost/<token>` on Android (as on Windows; `file_stream.rs` named the custom scheme before). A `<video>` loads and seeks, the scheme answers `bytes=0-` with 206. A `fetch` from the page fails: another origin, no CORS (media elements need none) |
| Touch only (no keyboard on opening a chat) | No on the emulator | The emulator reports both a coarse and a fine pointer, so the composer takes the focus and the keyboard opens. A phone normally reports coarse only |
| JavaScript timers, screen off for 60 s | Yes on the emulator | 60 ticks of 60. A phone's Doze and maker battery rules can differ: check on a phone |

### On a phone (checklist for Miguel)

The emulator cannot answer these. A debug build, so the WebView can be inspected from a computer.

1. Get the APK: Actions > Android native > the latest green run > Artifacts > `ghostly-android-debug-arm64-v8a` (or `gh run download <run id> -R MiguelMedeiros/ghostly -n ghostly-android-debug-arm64-v8a`), and unzip it.
2. Install it, either:
   - over USB: turn on Developer options and USB debugging on the phone, then `adb install -r ghostly-debug-arm64-v8a.apk`; or
   - without a computer: copy the APK to the phone, open it in Files, and allow "Install unknown apps" for Files when asked.
   The PWA's data stays in Chrome and is not seen by this app. Uninstalling the app removes all of its data.
3. Open it and make a profile. On the computer, `chrome://inspect` shows the app's WebView: its Console runs the checks below.
4. **WebView version and WebCrypto:** in the Console, `navigator.userAgent` (note the Chrome version) and `await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])` (an object means yes; "Unrecognized name" means no).
5. **No keyboard on opening a chat:** open a chat. The keyboard should stay down until the message field is tapped. In the Console: `matchMedia("(any-pointer: fine)").matches` should be `false`.
6. **Pair and talk:** pair with a web peer (app.ghostly.tools on the computer). Messages both ways; Settings > Network says "Direct UDP"; the chat's connection icon shows a direct or relayed Iroh link.
7. **Screen locked:** with the chat open, lock the phone. From the web peer, send a message after 1 minute and another after 5 minutes. Unlock and note whether they arrived while locked (the sender's delivery marks and their times), and how long the contact took to show as online again. Repeat with the app in the background (Home) instead of locked.
8. **Voice message (microphone):** record one. Android should ask for the microphone; note whether the recording plays on the web peer.
9. **Call:** call from the web peer and answer on the phone. Audio both ways? Then lock the screen during the call: does the audio go on, and for how long?
10. **Video:** send the phone a video over 64 MB from Desktop and play it (the `ghostly-file` scheme), including a seek.
11. Send the results (and anything odd: the battery settings of the phone's maker, a crash) to the coordinator. A crash's details: `adb logcat -d | grep -E "RustStdoutStderr|AndroidRuntime"`.

### Fixed during the spike

- The page drew under the status bar and the gesture bar (Android 15 enforces edge to edge): `MainActivity` pads the content by the system bars, the cutout and the keyboard, following the keyboard frame by frame.
- HTTPS from Rust panicked (above), so publishing an invite failed with "writes vanished".
- File bytes over Android's `postMessage` IPC, and the `ghostly-file` URL (above).
- Gradle ran the Tauri CLI as `node tauri`, which only works where `tauri android init` was run: it goes through `npm run tauri` now.

### Still open, by pull request

- **A1 (Android host):** the light status-bar strip over a dark app (the bars' colours should follow the theme); a native "Update Android System WebView" screen below a minimum version, checked in `MainActivity` before the page loads (the UI bundle needs Chrome 107 or later and is proven on 124; older shows a blank page, since the Desktop entry has no boot check); treat Android as touch only, whatever the pointer query says; the opener, share sheet and clipboard; OIDC through a deep link. Big files over IPC: a JSON array per chunk is slow, so smaller chunks or another path.
- **A3 (Keystore):** the device signing key already falls back to a stored seed when the WebView has no Ed25519 (`devices/signingKey.ts`), and no other code uses WebCrypto Ed25519 or X25519; the Keystore-sealed seed is what protects it on such a phone.
- **A4 (calls with the screen off):** only a phone can say whether WebView WebRTC and JavaScript keep running with the screen locked (the checklist).
- **A5 (fast resume):** a publish takes 3 to 5 s before its first ok, and an invite makes several; network changes may be seen late, since Android denies Iroh's netwatch the routing table.
- **A6 (push):** HTTPS from Rust works now, which `push_send` needs.
