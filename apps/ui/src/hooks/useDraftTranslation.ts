import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupMention } from "@ghostly/core";
import { translateTexts, TranslateError } from "../desktop/translate";
import { draftLanguage, draftParts, translateDraft } from "../lib/translateDraft";
import type { DetectLanguages } from "../lib/translateWhich";
import type { Language } from "../lib/settings";

/** What a chat gives its composer to translate a draft before it is sent (docs/AUTO-TRANSLATE.md § Outgoing translation). */
export interface ComposerTranslation {
  /** The chat's language for what I send (ISO 639-1), or null when a group has no single one. */
  language: string | null;
  /** A group with no single language: its languages, most used first, asked for on Translate. */
  languages?: readonly string[];
  /** The draft's language detector. Without it, a draft is taken to be in the app's language. */
  detect?: DetectLanguages;
  /** The model `pair` is not downloaded: asks whether to (the download question). True once it is there. */
  askModel?: (pair: string) => Promise<boolean>;
  /** Translates `texts` for `pair` (`<from>-<to>`): the Desktop app's runtime unless given. */
  translate?: (pair: string, texts: string[]) => Promise<string[]>;
}

/**
 * The preview above the composer: asking which language (a group with several), translating, or shown (`text`,
 * editable, made from the draft `source`; `same` when the draft is in that language already and goes as it is).
 */
export type DraftTranslation =
  | { step: "choose"; languages: readonly string[] }
  | { step: "working"; to: string; source: string }
  | { step: "shown"; to: string; source: string; text: string; same: boolean };

/** Why nothing came, said in the composer: no runtime, no model (and not downloaded now), or a failure. */
export type DraftTranslationFailure = "not-installed" | "no-model" | "failed";

/**
 * The draft's translation, made on Translate only, never on a keystroke. A later press (or Cancel) drops what an
 * earlier one was still making. A model that is not there is asked for once, and the translation runs again after.
 */
export function useDraftTranslation({ config, appLanguage, onFailure }: {
  config?: ComposerTranslation;
  appLanguage: Language;
  onFailure: (reason: DraftTranslationFailure, pair: string) => void;
}) {
  const [state, setState] = useState<DraftTranslation | null>(null);
  const run = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const failRef = useRef(onFailure); failRef.current = onFailure;

  /** Translates `draft` (its group mentions `named`) into `to`. */
  const translateInto = useCallback(async (to: string, draft: string, named: readonly GroupMention[] = []) => {
    if (!config) return;
    const source = draft.trim();
    const id = ++run.current;
    const current = () => mounted.current && run.current === id;
    const from = config.detect ? draftLanguage(source, config.detect, named) ?? appLanguage : appLanguage;
    if (from === undefined || from === to) { setState({ step: "shown", to, source, text: source, same: true }); return; }
    setState({ step: "working", to, source });
    const pair = `${from}-${to}`;
    const translate = config.translate ?? translateTexts;
    const parts = draftParts(source, named);
    let asked = false;
    for (;;) {
      try {
        const text = await translateDraft(parts, (texts) => translate(pair, texts));
        if (current()) setState({ step: "shown", to, source, text, same: false });
        return;
      } catch (cause) {
        if (!current()) return;
        const why = cause instanceof TranslateError ? cause.reason : "failed";
        // No runtime for this computer yet reads like none installed: either way nothing here can translate.
        const reason: DraftTranslationFailure = why === "off" ? "failed" : why === "unavailable" ? "not-installed" : why;
        // The reverse model, asked for the first time: downloaded, it runs again; "Not now" leaves the draft as it is.
        if (reason === "no-model" && !asked && config.askModel) {
          asked = true;
          if (await config.askModel(pair).catch(() => false)) { if (current()) continue; return; }
          if (current()) setState(null);
          return;
        }
        setState(null);
        failRef.current(reason, pair);
        return;
      }
    }
  }, [config, appLanguage]);

  /** Translate, pressed: into the chat's language, or first the question of which one in a group with several. */
  const start = useCallback((draft: string, named?: readonly GroupMention[]) => {
    if (!config) return;
    if (config.language) { void translateInto(config.language, draft, named); return; }
    // The app's own language is no choice: nothing would be translated.
    const languages = config.languages?.filter((code) => code !== appLanguage) ?? [];
    if (languages.length) { run.current++; setState({ step: "choose", languages }); }
  }, [config, appLanguage, translateInto]);

  const close = useCallback(() => { run.current++; setState(null); }, []);
  /** The translation, edited in the preview. */
  const edit = useCallback((text: string) => setState((was) => was?.step === "shown" ? { ...was, text } : was), []);

  return { state, start, translateInto, close, edit };
}

/** Whether the preview no longer matches the draft: it was changed after Translate. */
export function translationStale(state: DraftTranslation | null, draft: string): boolean {
  return !!state && state.step !== "choose" && state.source !== draft.trim();
}
