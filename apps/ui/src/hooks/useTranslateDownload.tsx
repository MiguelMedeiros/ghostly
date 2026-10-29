import { useCallback, useState } from "react";
import { TranslateDownloadDialog } from "../components/TranslateDownloadDialog";
import { useI18n } from "../contexts/I18nContext";
import { downloadBytes, downloadTranslation, translationStatus, type TranslationStatus } from "../desktop/translate";
import { rawError } from "../lib/errorText";
import type { Problem } from "../lib/problemText";
import type { Language } from "../lib/settings";
import { forgetTranslations } from "../lib/translateReceived";
import { firstPairs } from "../lib/translateSettings";

/**
 * Turning translation on (the Settings switch, or On for one chat) asks for the models it needs when they are not on
 * this computer (`firstPairs`), and Download fetches them. `ask(language)` opens the question; `question` is where it
 * renders. Nothing is asked where nothing would download: the models are all here, or this computer has no runtime to
 * get. After a download, the bubbles ask for their translations again, and `downloaded` runs (Settings reads its list).
 */
export function useTranslateDownload(downloaded?: () => void) {
  const { t } = useI18n();
  const [asking, setAsking] = useState<{ status: TranslationStatus; from: string; to: string; pairs: string[]; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const ask = useCallback(async (language: Language) => {
    const first = firstPairs(language);
    if (!first) return;
    let status: TranslationStatus;
    try { status = await translationStatus(); } catch { return; /* Settings says the list cannot be read */ }
    const bytes = downloadBytes(status, first.pairs);
    if (!bytes) return;
    setProblem(null);
    setAsking({ status, ...first, bytes });
  }, []);

  const download = async (question: NonNullable<typeof asking>) => {
    setBusy(true);
    setProblem(null);
    try {
      // One after the other; a pair already here answers at once, so Download again fetches only what is missing.
      for (const pair of question.pairs) await downloadTranslation(pair);
      setAsking(null);
    } catch (cause) {
      setProblem({ tone: "error", title: t("translate.download.failed"), next: t("translate.download.failedNext"), detail: rawError(cause) });
    } finally {
      setBusy(false);
      forgetTranslations();
      downloaded?.();
    }
  };

  const question = asking && (
    <TranslateDownloadDialog from={asking.from} to={asking.to} back={asking.pairs.length > 1} bytes={asking.bytes}
      engine={!asking.status.runtime} busy={busy} problem={problem} onNotNow={() => setAsking(null)} onDownload={() => void download(asking)} />
  );
  return { ask, question };
}
