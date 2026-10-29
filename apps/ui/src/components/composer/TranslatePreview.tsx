import { useEffect, useRef, type KeyboardEvent } from "react";
import { useI18n } from "../../contexts/I18nContext";
import type { DraftTranslation } from "../../hooks/useDraftTranslation";
import { languageName } from "../../lib/translateDraft";
import { fitFieldHeight } from "./fieldHeight";

const button = "rounded-full px-3 py-1.5 text-[13px] font-medium cursor-pointer border-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * The draft's translation above the composer, as the reply preview sits there: the language, the translated text
 * (editable), and Send translation (the default: Enter sends what is shown), Send original, Cancel. A draft changed
 * after Translate makes it stale: Translate again. In a group with no single language it first asks which one.
 */
export function TranslatePreview({ state, stale, disabled, onEdit, onChoose, onAgain, onSendTranslation, onSendOriginal, onCancel }: {
  state: DraftTranslation;
  stale: boolean;
  disabled?: boolean;
  onEdit: (text: string) => void;
  onChoose: (language: string) => void;
  onAgain: () => void;
  onSendTranslation: () => void;
  onSendOriginal: () => void;
  onCancel: () => void;
}) {
  const { t, language: appLanguage } = useI18n();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const shownText = state.step === "shown" ? state.text : null;
  useEffect(() => { if (fieldRef.current && shownText !== null) fitFieldHeight(fieldRef.current); }, [shownText]);

  if (state.step === "choose") {
    return (
      <section data-testid="translate-preview" data-step="choose" aria-label={t("composer.translate.choose")}
        className="mb-2 flex flex-col gap-2 rounded-lg bg-surface-alt px-3 py-2 animate-fade-in">
        <p className="m-0 text-[13px] text-text-secondary">{t("composer.translate.choose")}</p>
        <div className="flex flex-wrap gap-2">
          {state.languages.map((code) => (
            <button key={code} type="button" data-testid="translate-choose" data-language={code} onClick={() => onChoose(code)}
              className={`${button} bg-panel-header text-text-primary hover:bg-surface-hover`}>
              {languageName(code, appLanguage)}
            </button>
          ))}
          <button type="button" data-testid="translate-cancel" onClick={onCancel} className={`${button} bg-transparent text-text-muted hover:text-text-primary`}>
            {t("composer.translate.cancel")}
          </button>
        </div>
      </section>
    );
  }

  const name = languageName(state.to, appLanguage);
  const ready = state.step === "shown";
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (stale) onAgain(); else onSendTranslation(); }
  };
  return (
    <section data-testid="translate-preview" data-step={state.step} data-stale={stale || undefined} aria-label={t("composer.translate.region", { language: name })}
      className="mb-2 flex flex-col gap-1.5 rounded-lg border-s-4 border-accent bg-surface-alt px-3 py-2 animate-fade-in">
      <div className="flex items-baseline gap-2 text-[12.8px]">
        <span className="font-medium text-accent-hover">{name}</span>
        {state.step === "shown" && state.same && <span className="text-text-muted">{t("composer.translate.same", { language: name })}</span>}
        {stale && <span data-testid="translate-stale" className="text-text-muted">{t("composer.translate.stale")}</span>}
        {/* Announced once the translation is there, so a screen reader knows what Enter will send. */}
        <span role="status" className="sr-only">{ready ? t("composer.translate.ready", { language: name }) : t("composer.translate.working")}</span>
      </div>
      {ready ? (
        <textarea ref={fieldRef} data-testid="translate-text" dir="auto" rows={1} value={state.text} disabled={disabled}
          aria-label={t("composer.translate.region", { language: name })}
          onChange={(e) => { onEdit(e.target.value); fitFieldHeight(e.target); }} onKeyDown={onKeyDown}
          className="composer-textarea w-full resize-none rounded-md bg-panel-header px-2 py-1.5" />
      ) : (
        <p data-testid="translate-working" className="m-0 text-[13px] text-text-muted">{t("composer.translate.working")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {stale ? (
          <button type="button" data-testid="translate-again" onClick={onAgain} disabled={disabled} className={`${button} bg-accent text-on-accent hover:bg-accent-hover`}>
            {t("composer.translate.again")}
          </button>
        ) : (
          <button type="button" data-testid="translate-send" onClick={onSendTranslation} disabled={disabled || !ready || !state.text.trim()}
            className={`${button} bg-accent text-on-accent hover:bg-accent-hover`}>
            {t("composer.translate.sendTranslation")}
          </button>
        )}
        <button type="button" data-testid="translate-send-original" onClick={onSendOriginal} disabled={disabled}
          className={`${button} bg-panel-header text-text-primary hover:bg-surface-hover`}>
          {t("composer.translate.sendOriginal")}
        </button>
        <button type="button" data-testid="translate-cancel" onClick={onCancel} className={`${button} bg-transparent text-text-muted hover:text-text-primary`}>
          {t("composer.translate.cancel")}
        </button>
      </div>
    </section>
  );
}
