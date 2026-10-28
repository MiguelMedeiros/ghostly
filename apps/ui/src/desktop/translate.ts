import { invoke } from "@tauri-apps/api/core";
import { rawError } from "../lib/errorText";
import { translateEnabled } from "../lib/translateFlag";

/** The most texts Rust takes in one request (the runtime's `MAX_TEXTS`, apps/desktop/src/translate.rs). */
export const MAX_TEXTS = 64;

/**
 * Why there is no translation: the build has none (`off`), the translation runtime is not downloaded
 * (`not-installed`), the pair's model is not (`no-model`), this computer has no runtime to download yet
 * (`unavailable`), or it failed.
 */
export type TranslateFailure = "off" | "not-installed" | "no-model" | "unavailable" | "failed";

/** Rust's words for the ones the page acts on: the rest is a failure, whatever it says. */
const REASONS: Record<string, TranslateFailure> = {
  "Translation is not installed": "not-installed",
  "Translation model not downloaded": "no-model",
  "Translation is not available on this computer yet": "unavailable",
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
  if (!translateEnabled()) throw off();
  const translated: string[] = [];
  for (let at = 0; at < texts.length; at += MAX_TEXTS) {
    translated.push(...await ask<string[]>("translate_texts", { pair, texts: texts.slice(at, at + MAX_TEXTS) }));
  }
  return translated;
}

/** One pair Rust knows (`<from>-<to>`), with what it takes on disk: what it downloads. */
export interface TranslationPair {
  pair: string;
  bytes: number;
  downloaded: boolean;
}

export interface TranslationStatus {
  /** The translation runtime is on this computer. */
  runtime: boolean;
  /** What downloading the runtime takes here; null where there is none for this computer yet. */
  runtimeBytes: number | null;
  pairs: TranslationPair[];
}

/** What is on this computer and what each pair would download (apps/desktop/src/translate_models.rs). */
export function translationStatus(): Promise<TranslationStatus> {
  return ask("translation_status");
}

/**
 * The pair's model, and the runtime first when it is not here, each file checked against its pinned SHA-256: only
 * once the person said yes to the download question. Nothing is left on disk when it fails.
 */
export function downloadTranslation(pair: string): Promise<void> {
  return ask("translation_download", { pair });
}

/** The pair's model off this computer. */
export function removeTranslation(pair: string): Promise<void> {
  return ask("translation_remove", { pair });
}

/**
 * What downloading `pairs` takes: the ones not here yet, and the runtime when it is not; null when this computer has
 * no runtime to download.
 */
export function downloadBytes(status: TranslationStatus, pairs: readonly string[]): number | null {
  if (!status.runtime && status.runtimeBytes === null) return null;
  const models = status.pairs.filter((p) => pairs.includes(p.pair) && !p.downloaded).reduce((sum, p) => sum + p.bytes, 0);
  return models + (status.runtime ? 0 : status.runtimeBytes ?? 0);
}

const off = () => new TranslateError("off", "Translation is off in this build");

/** A command, never asked in a build without translation (`VITE_TRANSLATE`); Rust's refusal as a `TranslateError`. */
async function ask<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!translateEnabled()) throw off();
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    const said = rawError(cause);
    throw new TranslateError(REASONS[said] ?? "failed", said);
  }
}
