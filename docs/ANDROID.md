# Ghostly on Android

The Android app is the Desktop app (`apps/desktop`) built with [Tauri 2](https://v2.tauri.app/) for Android: the same UI and engine as Desktop, with native Iroh and direct Mainline DHT reads in Rust. Package id `tools.ghostly.app`, Android 8.0 (API 26) and up, arm64 phones (`arm64-v8a`).

It is not the whole Desktop yet. Left out on Android, and why (`#[cfg(desktop)]`, refusing stubs in `apps/desktop/src/mobile.rs`): HyperDHT (a Node program; native HyperDHT through Bare is its own piece of work), the updater and the clipboard crate (no Android support; Android's own clipboard is read through the Android host), keep awake, and the windows of shared and installed apps (a mobile app has one window). What Desktop does with the system's processes and windows, Android does through [the Android host](#the-android-host-a1). What is still open is listed at the end ([Still open](#still-open-by-pull-request)).

## Install it

Each release attaches the APK: `ghostly-<version>-android-arm64.apk`, signed with Ghostly's upload key, and listed in `SHA256SUMS.txt` like the other downloads. Check it, then install it:

```bash
sha256sum --ignore-missing -c SHA256SUMS.txt
adb install -r ghostly-<version>-android-arm64.apk   # over USB, with USB debugging on
```

Or copy the APK to the phone, open it in Files, and allow "Install unknown apps" for Files when asked. Each release installs over the last (the version code is `major * 1000000 + minor * 1000 + patch`), and Android refuses an update signed with another key.

A release made while the repository has no upload key has no APK, and its release notes say so. That run still builds a **debug** APK, `ghostly-<version>-android-arm64-debug.apk`, and keeps it as the run's `android` artifact: to try the app, never published. It is signed with the Android debug key of that one CI run, so nothing signed with another key installs over it: uninstall it (which removes its data) before installing the signed APK. A debug build can also be inspected over USB (`chrome://inspect`) and takes the test launch options [below](#build-it-locally), so it is not for daily use.

The app keeps its own data; the web app's (the PWA installed from Chrome) stays in Chrome. To move a profile, use [Several devices](DEVICES.md).

An earlier APK, built from source before 1.2 and never attached to a release, opened the web app in a Chrome window under the same package id. It was signed with a debug key, so Android refuses this app over it: uninstall it first. Its profile is Chrome's data for app.ghostly.tools, which uninstalling it leaves in place: open app.ghostly.tools in Chrome and add this app as a device.

## What CI does

Two workflows build the app:

- **Android** (`.github/workflows/android.yml`), the one releases use (`release.yml` calls it with the tag). One arm64 APK, `npm run tauri -- android build --apk --split-per-abi --target aarch64`:
  - With the upload key in the repository's secrets (below): a release build signed with it, `ghostly-<version>-android-arm64.apk`.
  - Without them: a debug build signed with the Android debug key, `ghostly-<version>-android-arm64-debug.apk`. The job summary says **DEBUG build** in bold, and the run carries a warning.
  - On a pull request that changes `apps/desktop/gen/android/`, `tauri.android.conf.json` or the workflow, once it is not a draft: the release path (R8, signing) with a key made for the run and thrown away, so a release is not the first build to try it. That APK is not uploaded.

  The APK is the run's `android` artifact (Actions > Android > Run workflow builds one from any branch). The job summary gives its size, version, whether it is debuggable, the signing certificate's SHA-256 fingerprint and the APK's SHA-256. A release build that comes out debuggable fails the run. The release takes a signed APK into its assets and `SHA256SUMS.txt`, and never a debug one; a failed Android build, or one without the upload key, does not hold a release back, and its notes then say there is no APK.

- **Android native** (`.github/workflows/android-native.yml`), on pull requests that touch `apps/desktop/` (once they are not drafts) and by hand: two debug APKs, `ghostly-android-debug-arm64-v8a` (phones, and an arm64 emulator on a Mac) and `ghostly-android-debug-x86_64` (the CI emulator). It then installs the x86_64 APK on an Android 15 emulator and runs `tools/scripts/android-smoke.mjs` (Playwright over adb, inside the app's WebView): it launches, the UI renders, the engine starts, and [the measurements](#what-the-emulator-measured-a0-october-2026). The table is in the job summary; screenshots, logcat and the app's log are in the `android-smoke` artifact.

  It keeps the Android debug key the Gradle plugin makes (an Actions cache), so a newer debug APK installs over an older one. When that cache is gone (7 days unused, or another branch), Android refuses the update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`): uninstall the old one first.

## Build it locally

You need Node 22, Rust with the `aarch64-linux-android` target, a JDK 17, the Android SDK and NDK 27.3 (`ndk;27.3.13750724`). Gradle fetches the SDK platform and build tools itself once the licences are accepted.

```bash
export JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk
export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"
rustup target add aarch64-linux-android
npm ci
npm run tauri -- android build --debug --apk --split-per-abi --target aarch64   # debug APK
npm run tauri -- android build --apk --split-per-abi --target aarch64           # release APK
```

The APKs land in `apps/desktop/gen/android/app/build/outputs/apk/arm64/`. The web build runs first (`tauri.android.conf.json`'s `beforeBuildCommand`). The version is the Desktop app's (`apps/desktop/tauri.conf.json`). `--target x86_64` builds for an emulator on a PC.

A release build is signed with the upload key when `ANDROID_KEYSTORE` names the keystore file, with `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` (`gen/android/app/build.gradle.kts`); without `ANDROID_KEYSTORE` it comes out unsigned (`app-arm64-release-unsigned.apk`), which Android will not install.

The Gradle project is `apps/desktop/gen/android` (generated by `tauri android init`, then edited: keep the edits when regenerating). `cargo check --target aarch64-linux-android -p ghostly --lib` (with the NDK's clang as `CC_aarch64_linux_android` and linker) checks the Rust alone.

The Gradle project's own Kotlin: `MainActivity.kt` (edge to edge, the WebView-version check) and `GhostlyHostPlugin.kt` (the Android host); the manifest's deep link, share target and permissions. Keep them when regenerating `gen/android`.

A debug build started with `adb shell am start -n tools.ghostly.app/.MainActivity --ez ghostly_e2e true` runs as under an e2e suite (no name step, never a new profile's default Mainnet wallets). A release build ignores the extra.

Such a start never reaches a public network unless told to. `MainActivity` sets every `--es GHOSTLY_… <value>` string extra (names `^GHOSTLY_[A-Z0-9_]+$` only) as the process's environment before Rust starts, over the defaults Desktop's e2e gets (`isolatedDesktopNetworkEnv`, `E2eEnvironment.kt`): `GHOSTLY_PKARR_RELAYS=http://127.0.0.1:9` (no public relays and no public Mainline DHT), `GHOSTLY_IROH_RELAYS=http://127.0.0.1:9` (no n0 relays) and `GHOSTLY_STUN=0`. WebRTC runs in the WebView, which Rust's environment does not reach: the page asks Rust once at start (`test_network`) and, with STUN off, wraps `RTCPeerConnection` so every connection leaves the apps' public STUN servers (`RTC_CONFIG`) out and keeps the profile's own ICE servers, as the CLI's `GHOSTLY_STUN=0` (`apps/ui/src/desktop/android.ts`). The e2e (`e2e/android`) passes its own loopback relays as extras; `--es GHOSTLY_TEST_PUBLIC_NET 1` keeps the public networks, which the smoke probe (`tools/scripts/android-smoke.mjs`) measures on purpose.

## Signing (one-time setup, Miguel)

Releases are signed with an upload key that only Miguel holds, offline. It never goes into the repository, and nothing in CI makes or prints it. Losing it means a new app for everyone who installed this one: an update signed with another key does not install.

1. Make the key on your own machine, and keep it (and its passwords) somewhere safe outside the repository:

   ```bash
   keytool -genkeypair -v -keystore ghostly-upload.keystore -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Add four secrets to the repository (Settings > Secrets and variables > Actions):

   - `ANDROID_KEYSTORE_B64`: the keystore in base64 (`base64 -i ghostly-upload.keystore | pbcopy` on macOS)
   - `ANDROID_KEYSTORE_PASSWORD`: the keystore's password
   - `ANDROID_KEY_ALIAS`: `upload`
   - `ANDROID_KEY_PASSWORD`: the key's password (the same as the keystore's unless you chose another)

3. Run Actions > Android > Run workflow. The summary should say "Release build, signed with the upload key", with the certificate's SHA-256 fingerprint: it should match `keytool -list -v -keystore ghostly-upload.keystore -alias upload | grep SHA256`.

From then on every release attaches the signed APK. CI writes the keystore to the runner's temporary folder for the build only and deletes it after; pull requests never see the secrets.

If the app is ever on Google Play with Play App Signing, this key becomes the upload key and Google signs what phones install.

## The Android host (A1)

The page runs the Desktop host (`apps/ui/src/desktop/host.ts`), so each Android piece sits behind a command the page already called. Rust (`apps/desktop/src/android.rs`) registers the app's own Tauri plugin, `GhostlyHostPlugin.kt`, and calls it; the plugin calls back into Rust (JNI, `received`) with what Android hands the app. No new dependency: `libc` (already in the lockfile) for the main-thread check.

| What | On Android | Behind |
|---|---|---|
| Opener | `ACTION_VIEW` with the app Android has for the URL (browser, maps, wallet); "No app on this phone opens this link" when none. The URL checks are Desktop's, before Android sees anything: http(s) only for `open_web_link`, Ghostly's pages only for `open_project_link`, `lightning:`/`bitcoin:` only for `open_payment_link`, Passport's authorize page only | `commands::launch`, so every opener, the OIDC browser and the notification settings |
| Clipboard | Writing: the page's own `navigator.clipboard.writeText` (the app's origin, `http://tauri.localhost`, is a secure context). Reading: Android's `ClipboardManager` (the WebView gives the page no `readText()`) | `read_clipboard_text` |
| Share sheet | `ACTION_SEND` in Android's chooser, with Desktop's checks (text, 4 KiB at most) | `share_text` |
| Share to Ghostly | An `ACTION_SEND`/`SEND_MULTIPLE` filter for any type. Text, subject and up to 32 streams; each stream is copied into the app's cache (one share at a time), and the page reads the copies by token, as a paste's, then opens the Share to… picker (`#/shared`). At start and on the `incoming-share` event. Once read, the share's copies leave the cache; a start removes any an earlier run left | `incoming_share_take`, `read_pasted_bytes`, `incoming_share_done` |
| Notifications | Asked only from the person's switch in Settings (Android 13+: POST_NOTIFICATIONS, then only Settings can change it); posted silent on a "Messages" channel (its name in the 8 languages), with a ghost small icon; a tap opens the app and the page hears `notification-open` with the id, which opens the chat. Refused, Settings says where to allow them and its "Open settings" opens the app's page in Android's settings | `native_notification_permission`, `native_private_notification`, `open_notification_settings` (the app's page in Android's settings) |
| Saving a received file | Android's document picker (`ACTION_CREATE_DOCUMENT`: Downloads, a cloud drive), then a copy to the address it answers | `file_bytes_save` |
| Choosing a file to send | The WebView's own file chooser (wry's `onShowFileChooser`) | `<input type="file">` |
| Sign-in (OIDC) | No loopback listener (a backgrounded app may be frozen): `oidc_loopback_start` answers port 0, the page asks with an `a.` state, the web callback page sends the answer to `ghostly://oidc?…#…`, which brings the app forward. Rust takes only the answer for the state it waits for, one sign-in at a time | `oidc_loopback_*`, `apps/web/src/oidcCallback.ts`, `packages/browser/src/proofs/oidc/popup.ts` |
| Network changes | Android's default-network callback tells every Iroh endpoint (`Endpoint::network_change()`) and the Pkarr client, since Iroh's netwatch is denied the routing table | `TransportState::network_changed` |
| System bars | The page's background colour and light or dark icons, now and on every theme change (Light, Dark, colour themes) | `system_bars` |
| Touch only | Always in the Android app, whatever the pointer query says (`apps/ui/src/lib/touchOnly.ts`) | |
| WebView too old | Below Chrome 111 (Vite's default build target), `MainActivity` hides the page behind a native "Update Android System WebView" screen with a button to the Play Store (its text in the 8 languages). A debug build takes `--ei ghostly_min_webview <major>` to show it on a newer WebView (the text names the minimum applied). The bars take the screen's own background, light or dark as the system's night mode; the page behind it no longer sets them | |

Apps (mini-apps) are off in the Android app for now (`appsPlatform` in `apps/ui/src/lib/apps/flag.ts`, which `desktopApps` in `apps/ui/src/desktop/host.ts` reads too): no Apps page, composer entry or app card, and no `apps/1` offered to contacts.

The OIDC redirect is the app's own scheme (`ghostly://oidc`) for now. An App Link (`https://app.ghostly.tools/...` opening the app) instead would need `/.well-known/assetlinks.json` on the site with the upload key's SHA-256 fingerprint and `android:autoVerify="true"` on the filter: a deploy, not done yet.

Each refusal the host can give reaches the page as the app's notice: a short title and the next step in the person's language, and the Rust or Kotlin reason (English, "No app on this phone opens this link") behind the ⓘ.

Tests: Rust (`oidc.rs` deep-link parsing and the state check, `clipboard.rs` a share read as a paste, `paired_transport.rs` a network change reaching every endpoint with a live connection going on, `commands.rs` the bars' colour and `test_network`), Kotlin (`app/src/test/.../E2eEnvironmentTest.kt`: the extras' names and the isolated defaults; a JVM unit test, `./gradlew :app:testUniversalDebugUnitTest`), the page (`apps/ui/src/test/app/androidHost.test.ts`: bars, shares, touch only, the STUN wrapper; `packages/browser/test/oidcFlow.test.ts`: the callback's routing; the refusals as notices in `test/ui/externalLinks.test.tsx`, `test/chat/messageDownload.test.tsx`, `test/identities/addIdentityDialog.test.tsx`, `test/app/systemNotifications.test.tsx`, and each English reason's rule in `test/i18n/errorText.test.ts`). The emulator probe (`tools/scripts/android-smoke.mjs`) checks each on the device: the opener's intent, refusals before Android, a payment link with no wallet, a clipboard round trip, the permission dialog and a notification posted and tapped, the share sheet, a text shared in reaching the picker, a deep link reaching a waiting sign-in (another state first, dropped), the bars in Dark and Light (screenshots), a network change in the app's log, and the WebView-update screen (screenshot).

## What the emulator measured (A0, October 2026)

Android 15 (API 35) x86_64 emulator on a CI runner, debug build. The emulator image's WebView is Chrome 124; a phone's WebView updates from the Play Store and is newer.

| What | Works | Measured |
|---|---|---|
| App starts, UI renders | Yes | Activity up in about 3 s, "New chat" on screen about 9 s after launch |
| Engine starts with the Desktop host | Yes | Settings shows "Mainline DHT (BEP44), Direct UDP" (Rust's Pkarr client) |
| Native Iroh endpoint | Yes | Binds in 0.1 to 0.6 s, gets its n0 relay and public address, a second endpoint connects to it in 25 to 175 ms |
| Netlink (Iroh's netwatch) | Partly | Android denies reading the routing table (`nlmsg_readpriv`, 3 SELinux denials per start); Iroh still finds its addresses. Network changes may be noticed late |
| Pkarr over UDP (Mainline DHT, no relay) | Yes | Write 2.9 to 3.6 s, read back 0.08 to 0.13 s |
| One publish, every source (the app's own log) | Yes, slow | DHT ok at 3.1 to 7.0 s once it has nodes, but "no closest nodes" for publishes in the first seconds after a start; pkarr.pubky.app and pkarr.pubky.org ok at 4.0 to 9.0 s, and twice a relay PUT ran past the 10 s write timeout. A publish counts as written at its first ok |
| New, until the invite is published | Yes, slow | 10.5 and 11.7 s (the pairing scene leaving "publishing"), with the app's own relays, about 20 s after launch |
| HTTPS from Rust (relays, link previews, push) | Yes, after a fix | `rustls-platform-verifier` panicked until it was given the JVM (`android_tls` in `lib.rs`; its Kotlin half is an `.aar` from the crate's Maven repository, pinned by SHA-256 in `gen/android/app/build.gradle.kts`, and the app's own network security config, `res/xml/network_security.xml`, stands in place of the one in that `.aar`: no cleartext in a release build, so Android fetches no revocation lists over `http://`, and cleartext in a debug build for the dev server and the e2e's relays); relay writes then "ok". The first HTTPS request after a start takes 2.7 s (Android's trust store loaded on first use, and DNS), the first to another host 0.6 to 1.2 s, later ones 0.02 to 0.2 s. So a relay's 4 to 10 s PUT is the relay's own answer, not TLS |
| WebRTC in the WebView | Yes | `RTCPeerConnection`, a data channel and host ICE candidates; `getUserMedia` present, microphone and speaker listed. `navigator.permissions.query` for microphone or camera throws |
| WebCrypto Ed25519 and X25519 | No on Chrome 124 | "Unrecognized name" on Chrome 124. Newer Chrome versions have them, so a phone with an updated WebView may; the phone checklist records which. Without them the device key is a stored seed (A3 seals it) |
| Files over IPC | Yes, after a fix | Android's IPC goes through `postMessage` (its WebView cannot read a request body), so bytes arrive as a JSON array; `file_bytes_append` accepts that now. Slow for big files |
| `ghostly-file` scheme | Yes, after a fix | Served at `http://ghostly-file.localhost/<token>` on Android (as on Windows; `file_stream.rs` named the custom scheme before). A `<video>` loads and seeks, the scheme answers `bytes=0-` with 206. A `fetch` from the page fails: another origin, no CORS (media elements need none) |
| Touch only (no keyboard on opening a chat) | No on the emulator (A0); forced since A1 | The emulator reports both a coarse and a fine pointer, so the composer took the focus and the keyboard opened. A phone normally reports coarse only. A1 treats the Android app as touch only whatever the query says |
| JavaScript timers, screen off for 60 s | Yes on the emulator | 60 ticks of 60. A phone's Doze and maker battery rules can differ: check on a phone |

## On a phone (checklist for Miguel)

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
11. **The Android host (A1):** share a photo from the gallery to Ghostly (the Share to… picker lists the chats; the photo is on the attachment sheet once one is picked); turn notifications on in Settings (Android asks once), lock the phone, have the web peer write, and tap the notification (the chat opens); add an identity with Google or GitLab sign-in (the browser opens, and returns to the app; if it stays on "Returning to Ghostly…", tap "Open Ghostly" and note it); save a received file to Downloads; switch Light and Dark in Settings and look at the status and navigation bars; move from Wi-Fi to mobile data during a chat and note how long the contact takes to come back (the app's log says "network: changed").
12. Send the results (and anything odd: the battery settings of the phone's maker, a crash) to the coordinator. A crash's details: `adb logcat -d | grep -E "RustStdoutStderr|AndroidRuntime"`.

## Fixed during the spike

- The page drew under the status bar and the gesture bar (Android 15 enforces edge to edge): `MainActivity` pads the content by the system bars, the cutout and the keyboard, following the keyboard frame by frame.
- HTTPS from Rust panicked (above), so publishing an invite failed with "writes vanished".
- File bytes over Android's `postMessage` IPC, and the `ghostly-file` URL (above).
- Gradle ran the Tauri CLI as `node tauri`, which only works where `tauri android init` was run: it goes through `npm run tauri` now.

## Still open, by pull request

- **A1 (Android host), what is left:** the A1 rows of the emulator probe have not run yet (the pull request's CI run is their first); a phone has to confirm a sign-in end to end (a real provider, the browser opening `ghostly://oidc` from the callback page: a browser may want the tap on "Open Ghostly" the page shows), a file shared in from a gallery or Files app (content URIs, which adb cannot make), a notification tapped from the shade, and the bars on a phone's own gesture or button navigation. A tap on a notification after Android ended the process opens the app but not the chat (the page keeps which chat a notification was about in memory only). Big files over IPC (a JSON array per chunk over `postMessage`, slow): not done, it needs its own path (smaller chunks, or the bytes through a file the page never sees).
- **A3 (Keystore):** the device signing key already falls back to a stored seed when the WebView has no Ed25519 (`devices/signingKey.ts`), and no other code uses WebCrypto Ed25519 or X25519; the Keystore-sealed seed is what protects it on such a phone.
- **A4 (calls with the screen off):** only a phone can say whether WebView WebRTC and JavaScript keep running with the screen locked (the checklist).
- **A5 (fast resume, and New):** an invite took 10.5 to 11.7 s to publish. Right after a start the DHT has no nodes yet, so a publish waits on the relays, whose PUT takes 4 to 10 s and sometimes passes the 10 s write timeout. A write timeout counts as a relay failure, which leaves that relay alone for its back-off, so later publishes go to the DHT alone (what the Mac emulator showed: about 20 s for New). To look at: a slow PUT should not trip the breaker (or a longer write timeout), and the DHT bootstrapped as the app starts. Android denies Iroh's netwatch the routing table; since A1 Android's own network callback tells Iroh and Pkarr of a change, which a phone moving between Wi-Fi and mobile data should confirm.
- **A6 (push):** HTTPS from Rust works now, which `push_send` needs.
