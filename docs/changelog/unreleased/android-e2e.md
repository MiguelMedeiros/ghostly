---
section: For developers
---
- The native Android app's e2e lane: Playwright specs in `e2e/android` drive the debug APK on an emulator with a web peer on the same machine (launch, New, chat, files and video, and the Android host's links, clipboard, notifications, share and sign-in deep link), run by Actions > Android e2e. The phone checklist is `docs/ANDROID-PHONE.md`, with `tools/scripts/android-phone-check.mjs` reading what a computer can from a phone on USB.
