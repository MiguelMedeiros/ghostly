import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TranslateDownloadDialog } from "../components/TranslateDownloadDialog";
import { useI18n } from "../contexts/I18nContext";
import { downloadBytes, downloadTranslation, translationStatus, type TranslationStatus } from "../desktop/translate";
import { rawError } from "../lib/errorText";
import type { Problem } from "../lib/problemText";
import type { Language } from "../lib/settings";
import { forgetTranslations } from "../lib/translateReceived";
import { firstPairs, readingPairs } from "../lib/translateSettings";

interface Asked { status: TranslationStatus; from: string; to: string; back: boolean; pairs: string[]; bytes: number }

/**
 * A download goes on in Desktop whatever the app shows (it has no cancel), for minutes with the engine: closing the
 * question or leaving Settings leaves it running. So what it is doing is the app's, not the question's.
 */
interface Downloads {
  /** The questions whose Download is on now; another question's languages can download beside them. */
  running: readonly Asked[];
  /** The pairs the last download brought; a new list each time one ends, also one that failed midway. */
  finished: readonly string[];
  /** It failed with its question gone: `useTranslateDownloadFailure` asks again. */
  failed: { asked: Asked; problem: Problem } | null;
}

let downloads: Downloads = { running: [], finished: [], failed: null };
const listeners = new Set<() => void>();
const setDownloads = (change: Partial<Downloads>) => {
  downloads = { ...downloads, ...change };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const useDownloads = () => useSyncExternalStore(subscribe, () => downloads);

/** Languages are downloading now, whoever asked: Settings says so. */
export const useTranslateDownloading = () => useDownloads().running.length > 0;

const samePairs = (a: Asked | null, pairs: readonly string[]) => !!a && a.pairs.every((pair) => pairs.includes(pair));

/**
 * Turning translation on (the Settings switch, or On for one chat) asks for the models it needs when they are not on
 * this computer, and Download fetches them. `ask(language, chatLanguage)` opens the question: for a chat whose
 * language is known, what reading it takes (`readingPairs`), else the app's language to English and back
 * (`firstPairs`). `question` is where it renders. Nothing is asked where nothing would download: the models are all
 * here, or this computer has no runtime to get. After a download, the bubbles ask for their translations again, and
 * `downloaded` runs (Settings reads its list).
 */
export function useTranslateDownload(downloaded?: () => void) {
  const { t } = useI18n();
  const [asking, setAsking] = useState<Asked | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const { running, finished } = useDownloads();

  const onScreen = useRef<Asked | null>(null);
  useEffect(() => {
    onScreen.current = asking;
    return () => { onScreen.current = null; };
  }, [asking]);

  const seen = useRef(finished);
  useEffect(() => {
    if (seen.current === finished) return;
    seen.current = finished;
    setAsking((was) => samePairs(was, finished) ? null : was);
    downloaded?.();
  }, [finished, downloaded]);

  const ask = useCallback(async (language: Language, chatLanguage?: string | null) => {
    const first = chatLanguage ? null : firstPairs(language);
    if (chatLanguage === language || (!chatLanguage && !first)) return;
    let status: TranslationStatus;
    try { status = await translationStatus(); } catch { return; /* Settings says the list cannot be read */ }
    // Through English is two pairs one way: only the app's language to English and back is "and back".
    const wanted = first ? { ...first, back: true } : { from: chatLanguage!, to: language, back: false, pairs: readingPairs(chatLanguage!, language, status.pairs.map((p) => p.pair)) };
    // A language with no pinned model (a detected `de`, say) has nothing to download: asking would fail forever.
    const known = new Set(status.pairs.map((p) => p.pair));
    if (!wanted.pairs.length || wanted.pairs.some((pair) => !known.has(pair))) return;
    const bytes = downloadBytes(status, wanted.pairs);
    if (!bytes) return;
    setProblem(null);
    setAsking({ status, ...wanted, bytes });
  }, []);

  const download = async (question: Asked) => {
    setProblem(null);
    setDownloads({ running: [...downloads.running, question], failed: null });
    const brought: string[] = [];
    try {
      // One after the other; a pair already here answers at once, so Download again fetches only what is missing.
      for (const pair of question.pairs) { await downloadTranslation(pair); brought.push(pair); }
    } catch (cause) {
      const failure: Problem = { tone: "error", title: t("translate.download.failed"), next: t("translate.download.failedNext"), detail: rawError(cause) };
      if (onScreen.current === question) setProblem(failure);
      else setDownloads({ failed: { asked: question, problem: failure } });
    } finally {
      forgetTranslations();
      setDownloads({ running: downloads.running.filter((on) => on !== question), finished: brought });
    }
  };

  const askAgain = useCallback((failed: NonNullable<Downloads["failed"]>) => {
    setProblem(failed.problem);
    setAsking(failed.asked);
  }, []);

  // Busy only while these languages are what downloads: a question for others, asked meanwhile, still downloads them.
  const busy = !!asking && running.some((on) => samePairs(asking, on.pairs));
  const question = asking && (
    <TranslateDownloadDialog from={asking.from} to={asking.to} back={asking.back} bytes={asking.bytes}
      engine={!asking.status.runtime} busy={busy} problem={problem} onNotNow={() => setAsking(null)} onDownload={() => void download(asking)} />
  );
  return { ask, question, askAgain };
}

/** The question again for a download that failed with its own gone, for `TranslateDownloadFailure` to render. */
export function useTranslateDownloadFailure() {
  const { question, askAgain } = useTranslateDownload();
  const { failed } = useDownloads();
  useEffect(() => {
    if (!failed) return;
    setDownloads({ failed: null });
    askAgain(failed);
  }, [failed, askAgain]);
  return question;
}
