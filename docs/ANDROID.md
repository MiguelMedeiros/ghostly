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
