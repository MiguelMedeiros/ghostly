/**
 * /android: the native Android app, as the release attaches it (docs/ANDROID.md):
 * where to get the APK, how to install it, how it updates, and how to check
 * that it is Ghostly's. Checked against apps/desktop's Android build and the
 * app's Settings, About on `dev`.
 */
export const android = {
  meta: {
    title: "Ghostly for Android: install the APK",
    description:
      "Install Ghostly's native Android app from its signed APK, see how it updates, and check the signing certificate's fingerprint.",
  },
  hero: {
    eyebrow: "Android",
    title: "Ghostly on your Android phone.",
    lead: "The native app: chats, files, calls and wallets, with your contacts reached straight from your phone. It comes as an APK from each release on GitHub, not from a store.",
    download: "Download APK",
    open: "Or open it in your browser",
    needs: (min: string) => `Android ${min} or newer · arm64 phones · free and open source`,
    scan: "On your computer? Scan this with your phone's camera to open this page there.",
    qr: "QR code for ghostly.tools/android",
  },
  install: {
    title: "Install it",
    steps: [
      { title: "Download the APK on your phone", body: "Tap Download APK above. Your browser may warn that the file can harm your device: keep it, it is Ghostly's own release file." },
      {
        title: "Let your browser install apps",
        body: "Open the downloaded file. The first time, Android says your browser is not allowed to install unknown apps: tap Settings, turn on Allow from this source, and go back.",
      },
      { title: "Install and open Ghostly", body: "Tap Install, then Open. Ghostly starts as on any other device: pick a name and create an invitation." },
    ],
  },
  updates: {
    title: "It tells you when there is a new version",
    body: "The app looks for a new release when it opens, every four hours, and when you come back to it. When one is out, Settings, About offers it: tap Download, open the new APK, and it installs over this one, with your chats still there. Check for updates automatically, in the same place, turns these checks off.",
  },
  verify: {
    title: "Check that it is Ghostly's",
    lead: "Every release APK is signed with the same key, and Android refuses an update signed with another one. The signing certificate's SHA-256 fingerprint:",
    copy: "Copy",
    copied: "Copied",
    command: "On a computer with the Android SDK's build tools, compare it with what apksigner prints:",
    sums: "Each release also lists the APK's SHA-256 in SHA256SUMS.txt, beside the other downloads.",
    all: "All files of this release",
  },
  other: {
    title: "Not on an arm64 Android phone?",
    body: "On an iPhone, an older or an x86 Android device, open Ghostly in your browser: it installs as an app from the browser's menu, nothing to download.",
    cta: "Open app.ghostly.tools",
    desktop: "Ghostly for your computer",
  },
};
