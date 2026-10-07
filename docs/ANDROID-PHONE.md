# The native Android app on a phone

The checklist of [ANDROID.md](ANDROID.md) ("On a phone"), as numbered steps with what each should show. The emulator in
CI cannot answer these (Actions > Android e2e and Android native cover what it can). A debug build, so the app's
WebView can be read from a computer.

`tools/scripts/android-phone-check.mjs` does the steps a computer can read (marked **script**) and prints a table: run
it once the app is installed and open (step 4), and send that table with your answers to the other steps.

You need: the phone, a USB cable, a computer with `adb` (Android platform tools) and, for the script, this repository
with `npm ci` done.

## Install

1. **Get the APK.** Actions > Android native > the latest green run > Artifacts > `ghostly-android-debug-arm64-v8a`
   (or `gh run download <run id> -R MiguelMedeiros/ghostly -n ghostly-android-debug-arm64-v8a`), and unzip it.
   Expected: `ghostly-debug-arm64-v8a.apk`.
2. **Turn on USB debugging.** Settings > About phone > tap Build number 7 times; then Settings > System > Developer
   options > USB debugging on. Plug the phone in and allow the computer on the phone's prompt.
   Expected: `adb devices` lists the phone as `device` (not `unauthorized`).
3. **Install it:** `adb install -r ghostly-debug-arm64-v8a.apk` (or copy the APK to the phone, open it in Files and
   allow "Install unknown apps" for Files).
   Expected: `Success`. An `INSTALL_FAILED_UPDATE_INCOMPATIBLE` means an older debug build signed with another key:
   `adb uninstall tools.ghostly.app` first (that removes its data). The PWA's data stays in Chrome and is not seen by
   this app.
4. **Open it and make a profile.**
   Expected: the chat list with New and Join within about 10 s, no blank or white page. On the computer,
   `chrome://inspect` lists the app's WebView.

## What the script reads

5. **Run the script:** `node tools/scripts/android-phone-check.mjs` (`--serial <id>` with several devices,
   `--out phone.md` to keep the table, `--screen-off 0` to skip the minute with the screen off). Leave the phone alone
   while it runs: it turns the screen off for 60 s and on again.
   Expected, one row each:
   - **device:** the maker, model, Android version and ABI (arm64-v8a).
   - **app:** `tools.ghostly.app`, a debug build.
   - **WebView:** the Chrome version (the emulator's is 124; a phone's updates from the Play Store and is newer).
   - **WebCrypto Ed25519 / X25519:** yes on a recent WebView; "Unrecognized name" means no, and the device key is then
     a stored seed (A3 seals it).
   - **touch only:** `any-pointer: fine false` on a phone. If it says fine true, the keyboard will open on opening a
     chat (step 7 shows it).
   - **notification permission:** granted or not yet asked (it is asked when notifications are turned on in Settings).
   - **background limits:** the standby bucket and whether battery optimisation is on: they decide step 9.
   - **JS timers, screen off 60 s:** about 60 ticks of 60; fewer means the page sleeps with the screen off.
   - **crashes in logcat:** none.

   The same by hand, in `chrome://inspect`'s Console for the app: `navigator.userAgent`,
   `await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])` (an object means yes),
   `matchMedia("(any-pointer: fine)").matches` (should be `false`).

## What only you can see

6. **Pair and talk.** Pair with a web peer: New on the phone, open the invite on app.ghostly.tools on the computer (or
   the other way round).
   Expected: the chat goes live within about 30 s; messages both ways; Settings > Network says "Direct UDP"; the chat's
   connection icon shows a direct or relayed Iroh link (or WebRTC).
7. **No keyboard on opening a chat.** Open the chat from the list.
   Expected: the keyboard stays down until the message field is tapped.
8. **Notifications.** Settings > System notifications on, allow on Android's prompt. Put the app in the background
   (Home) and send a message from the web peer.
   Expected: a notification that says "New message", never the text; tapping it opens the chat.
9. **Screen locked.** With the chat open, lock the phone. From the web peer, send a message after 1 minute and another
   after 5 minutes. Unlock.
   Expected (and note what really happened): both arrived while locked (the sender's delivery marks and their times),
   and how long the contact took to show as online again. Then the same with the app in the background (Home)
   instead of locked.
10. **Voice message (microphone).** Record one in the chat.
    Expected: Android asks for the microphone once; the recording plays on the web peer.
11. **Call.** Call from the web peer and answer on the phone.
    Expected: audio both ways. Then lock the screen during the call: note whether the audio goes on, and for how
    long.
12. **Video.** Send the phone a video over 64 MB from Desktop and play it, with a seek.
    Expected: it plays and seeks (the `ghostly-file` scheme); note how long the transfer took.
13. **Send the results** to the coordinator: the script's table, your answers to steps 6 to 12, the maker's battery
    settings for the app (Settings > Apps > Ghostly > Battery), and anything odd. A crash's details:
    `adb logcat -d | grep -E "RustStdoutStderr|AndroidRuntime"`.
