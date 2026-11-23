import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useSettings } from "../../contexts/SettingsContext";
import { removeTranslation, translationStatus, type TranslationPair } from "../../desktop/translate";
import { languageName } from "../../lib/documentLanguage";
import { rawError } from "../../lib/errorText";
import { focusLost } from "../../lib/focus";
import { forgetTranslations } from "../../lib/translateReceived";
import { downloadedLanguages } from "../../lib/translateSettings";
import { Row } from "../layout";
import { useTranslateDownload, useTranslateDownloading } from "../../hooks/useTranslateDownload";
import { Button, Switch } from "../wallet/ui";

/**
 * Settings → Appearance, under Language: **Translate messages into <language>**, and below it the language pairs on
 * this computer with their sizes and Remove. The pairs are listed whether the switch is on or off: they are the
 * computer's, shared by its profiles, and take disk space either way. Shown only where lib/translateSettings.ts's
 * `translateOffered` says so.
 */
export function TranslateSettings() {
  const { settings, updateTranslateMessages } = useSettings();
  const { t } = useI18n();
  const [pairs, setPairs] = useState<TranslationPair[]>([]);
  const [unread, setUnread] = useState<unknown>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ pair: string; cause: unknown } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const read = useCallback(async () => {
    try {
      // Every pinned pair comes with its size: the list is the ones on disk.
      setPairs((await translationStatus()).pairs.filter((pair) => pair.downloaded));
      setUnread(null);
    } catch (cause) {
      setUnread(cause);
    }
  }, []);
  useEffect(() => { void read(); }, [read]);
  const { ask, question } = useTranslateDownload(read);
  const downloading = useTranslateDownloading();

  // A Remove that went through, or a Try again that read the list, takes its row away and the focus with it: it goes to
  // the Remove now at `land` (the one after the gone pair, else the last), or the switch when no pair is left. A list
  // that could not be read hands it to its Try again. Nothing lands while the Remove or Try again still works: a draw in
  // between (a download starting, a settings change) would use the landing up while the button still has the focus.
  const land = useRef<number | null>(null);
  const removeButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const retryButton = useRef<HTMLButtonElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const at = land.current;
    if (at === null || removing !== null || retrying) return;
    land.current = null;
    if (!focusLost()) return;
    const buttons = removeButtons.current.filter((button) => button?.isConnected);
    (retryButton.current ?? buttons[Math.min(at, buttons.length - 1)] ?? toggle.current)?.focus({ preventScroll: true });
  });

  const remove = async (pair: string, at: number) => {
    setRemoving(pair);
    setFailed(null);
    try {
      await removeTranslation(pair);
      forgetTranslations();
      land.current = at;
      await read();
    } catch (cause) {
      setFailed({ pair, cause });
    } finally {
      setRemoving(null);
    }
  };

  const title = t("settings.translate.title", { language: languageName(settings.language, settings.language) });
  const lines = downloadedLanguages(pairs, t);
  return (
    <>
      <Row label={title} hint={t("settings.translate.hint")} info={t("settings.translate.info")} testId="settings-translate-row">
        <Switch ref={toggle} testId="settings-translate" label={title} checked={settings.translateMessages} onChange={(on) => {
          updateTranslateMessages(on);
          // Turned on: what the app's language is missing is asked before anything downloads, whatever other pairs are
          // here (a chat set to On brought its own). Nothing is asked when both ways are here.
          if (on && unread === null) void ask(settings.language);
        }} />
      </Row>
      {question}
      {downloading && <Row label={t("settings.translate.downloaded")} hint={<span role="status">{t("settings.translate.downloading")}</span>} testId="settings-translate-downloading" />}
      {unread !== null ? (
        <Row label={t("settings.translate.downloaded")} hint={<span role="status">{t("settings.translate.unread")}</span>} info={rawError(unread)}
          testId="settings-translate-unread">
          <Button ref={retryButton} loading={retrying} onClick={() => {
            land.current = 0;
            setRetrying(true);
            void read().finally(() => setRetrying(false));
          }}>{t("settings.languageRetry")}</Button>
        </Row>
      ) : lines.length === 0 ? (
        settings.translateMessages && <Row label={t("settings.translate.none")} testId="settings-translate-none" />
      ) : lines.map((line, i) => {
        const lost = failed?.pair === line.pair ? failed.cause : null;
        return (
          <Row key={line.pair} label={line.label} value={line.size} testId="settings-translate-pair"
            hint={lost !== null ? <span role="status">{t("settings.translate.removeFailed")}</span> : undefined} info={lost !== null ? rawError(lost) : undefined}>
            <Button ref={(button) => { removeButtons.current[i] = button; }} loading={removing === line.pair} disabled={removing !== null}
              aria-label={t("settings.translate.removeLabel", { name: line.label })} onClick={() => void remove(line.pair, i)}>
              {t("settings.translate.remove")}
            </Button>
          </Row>
        );
      })}
    </>
  );
}
