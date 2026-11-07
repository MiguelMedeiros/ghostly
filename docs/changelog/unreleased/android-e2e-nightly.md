---
section: For developers / CI
---
- The Android e2e lane also runs on pull requests that change page code only the Android app runs (`apps/ui/src/desktop/android*.ts` and the files that branch on `androidApp()`), and every night on dev, where it adds an Android 11 (API 30) emulator to the Android 15 one. Engine changes no longer wait for the next Desktop pull request to meet the Android specs.
