import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useSettings } from "../../contexts/SettingsContext";
import { removeTranslation, translationStatus, type TranslationPair } from "../../desktop/translate";
import { languageName } from "../../lib/documentLanguage";
import { rawError } from "../../lib/errorText";
import { forgetTranslations } from "../../lib/translateReceived";
import { downloadedLanguages } from "../../lib/translateSettings";
import { Row } from "../layout";
import { useTranslateDownload } from "../../hooks/useTranslateDownload";
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
  const { ask, question } = useTranslateDownload(() => void read());

  const remove = async (pair: string) => {
    setRemoving(pair);
    setFailed(null);
    try {
      await removeTranslation(pair);
      forgetTranslations();
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
        <Switch testId="settings-translate" label={title} checked={settings.translateMessages} onChange={(on) => {
          updateTranslateMessages(on);
          // Turned on with no language here: what it needs is asked before anything downloads.
          if (on && unread === null && lines.length === 0) void ask(settings.language);
        }} />
      </Row>
      {question}
      {unread !== null ? (
        <Row label={t("settings.translate.downloaded")} hint={<span role="status">{t("settings.translate.unread")}</span>} info={rawError(unread)}
          testId="settings-translate-unread">
          <Button onClick={() => void read()}>{t("settings.languageRetry")}</Button>
        </Row>
      ) : lines.length === 0 ? (
        settings.translateMessages && <Row label={t("settings.translate.none")} testId="settings-translate-none" />
      ) : lines.map((line) => {
        const lost = failed?.pair === line.pair ? failed.cause : null;
        return (
          <Row key={line.pair} label={line.label} value={line.size} testId="settings-translate-pair"
            hint={lost !== null ? <span role="status">{t("settings.translate.removeFailed")}</span> : undefined} info={lost !== null ? rawError(lost) : undefined}>
            <Button loading={removing === line.pair} disabled={removing !== null} aria-label={t("settings.translate.removeLabel", { name: line.label })} onClick={() => void remove(line.pair)}>
              {t("settings.translate.remove")}
            </Button>
          </Row>
        );
      })}
    </>
  );
}
