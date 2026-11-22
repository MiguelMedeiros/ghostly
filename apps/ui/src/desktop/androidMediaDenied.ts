import { androidApp } from "../lib/touchOnly";

/*
 * A microphone or camera refused in the Android app. Android, not a browser, asks for them there, and once it stops
 * asking ("Don't allow" twice) only its settings for Ghostly allow them again (`openAppSettings`, #5645). The page
 * code that words a refusal for Android asks here, so a change to it runs the Android lane (android-e2e.yml paths).
 */

/** True in the Android app: a refusal says how to allow it there and offers Android's settings. */
export function mediaDeniedOnAndroid(): boolean {
  return androidApp();
}

/**
 * True in the Android app: Allow asks for the microphone and the camera one at a time. Android asks for each in its
 * own dialog, and the app's WebView refuses a request for both unless both were allowed, so a microphone allowed with
 * the camera refused would name nothing and say "Blocked".
 */
export function asksEachAlone(): boolean {
  return androidApp();
}
