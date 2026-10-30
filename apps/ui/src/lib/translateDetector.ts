import type { DetectLanguages } from "./translateWhich";

/**
 * The language detector received messages are read with (translateWhich.ts takes it as a parameter):
 * `@qvac/langdetect-text`'s `detectMultiple`, loaded on the first message to translate and never in the start bundle.
 */
export async function loadDetector(): Promise<DetectLanguages | null> {
  const { detectMultiple } = await import("@qvac/langdetect-text");
  return (text) => detectMultiple(text);
}
