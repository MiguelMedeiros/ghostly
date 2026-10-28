import { invoke } from "@tauri-apps/api/core";
import { rawError } from "../lib/errorText";
import { translateEnabled } from "../lib/translateFlag";

/** The most texts Rust takes in one request (the runtime's `MAX_TEXTS`, apps/desktop/src/translate.rs). */
export const MAX_TEXTS = 64;

/**
 * Why there is no translation: the build has none (`off`), the translation runtime is not downloaded
 * (`not-installed`), the pair's model is not (`no-model`), or it failed.
 */
export type TranslateFailure = "off" | "not-installed" | "no-model" | "failed";

/** Rust's words for the first two, which the page acts on: the rest is a failure, whatever it says. */
const REASONS: Record<string, TranslateFailure> = {
  "Translation is not installed": "not-installed",
  "Translation model not downloaded": "no-model",
};

/** A translation that did not come. Its message is Rust's English, for the details behind the ⓘ: never a text. */
export class TranslateError extends Error {
  constructor(readonly reason: TranslateFailure, message: string) {
    super(message);
    this.name = "TranslateError";
  }
}

/**
 * `texts` translated on this computer from `pair` (`<from>-<to>`, as `pt-en`), in the order given, by the
 * translation runtime Rust starts on the first request and stops once idle. More than `MAX_TEXTS` go as several
 * requests, one after the other. In a build without translation (`VITE_TRANSLATE`) nothing is asked and no runtime
 * starts: it fails as `off`.
 */
export async function translateTexts(pair: string, texts: readonly string[]): Promise<string[]> {
  if (!translateEnabled()) throw new TranslateError("off", "Translation is off in this build");
  const translated: string[] = [];
  for (let at = 0; at < texts.length; at += MAX_TEXTS) {
    const batch = texts.slice(at, at + MAX_TEXTS);
    try {
      translated.push(...await invoke<string[]>("translate_texts", { pair, texts: batch }));
    } catch (cause) {
      const said = rawError(cause);
      throw new TranslateError(REASONS[said] ?? "failed", said);
    }
  }
  return translated;
}
