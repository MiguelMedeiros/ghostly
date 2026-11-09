---
section: For developers / CI
---
- The Android e2e lane also runs on pull requests that change page code only the Android app runs (`apps/ui/src/desktop/android*.ts` and the files that branch on `androidApp()`), and every night on dev. The Android 11 (API 30) emulator is left out until it has a WebView the app takes (its image ships WebView 83, the app needs 111), and the harness now refuses such a device at once, naming both versions, instead of every spec timing out. Engine changes no longer wait for the next Desktop pull request to meet the Android specs.
