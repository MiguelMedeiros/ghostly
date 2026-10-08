---
section: For developers / Android
---
- The Android app built from the web app in a Chrome window (a Trusted Web Activity, `apps/android-twa`) is removed, with the web app's `/.well-known/assetlinks.json` that only it used: the native app replaces it in 1.2. No release ever attached its APK. If you built and installed it, uninstall it before installing the native app (same package id, another key); its profile stays in Chrome for app.ghostly.tools and moves to the native app with [Several devices](docs/DEVICES.md).
