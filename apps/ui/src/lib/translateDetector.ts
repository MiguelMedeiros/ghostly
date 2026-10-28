import type { DetectLanguages } from "./translateWhich";

/**
 * The language detector received messages are read with (translateWhich.ts takes it as a parameter):
 * `@qvac/langdetect-text`'s `detectMultiple`, loaded on the first message to translate and never in the start bundle.
 * The package is not a dependency of the app yet: until it is, there is no detector and no message is translated. Adding
 * it is this one line, `return import("@qvac/langdetect-text").then((m) => m.detectMultiple);`.
 */
export async function loadDetector(): Promise<DetectLanguages | null> {
  return null;
}
