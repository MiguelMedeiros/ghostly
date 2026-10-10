---
section: Fixed / Android
release: 1.3
---
- A release built while the repository has no Android upload key no longer attaches a debug APK: it goes out without an APK and its notes say so. A debug build takes test launch options and can be inspected over USB, so it stays the CI run's artifact, to try the app only.
