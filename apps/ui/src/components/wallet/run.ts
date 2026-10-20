import { useState } from "react";
import { problemText, type Problem } from "../../lib/problemText";
import { useT } from "../../contexts/I18nContext";
import { saveMade } from "../../lib/fileDownload";
import { servicesPlatform } from "../../lib/platform";

/**
 * Runs one wallet operation at a time and keeps its error, as a notice says it (lib/problemText.ts): a few words, the
 * engine's English behind the ⓘ. `setError` takes a line of the app's own ("" clears it). `running` is the `key` of the
 * operation under way: the button that started it shows it (`loading`), the others of the card are only disabled.
 */
export function useRun() {
  const t = useT();
  const [running, setRunning] = useState<string | null>(null), [error, setProblem] = useState<Problem | null>(null);
  const setError = (text: string) => setProblem(text ? { tone: "error", title: text } : null);
  const run = async (work: () => Promise<unknown>, key = "") => {
    setRunning(key); setProblem(null);
    try { await work(); } catch (e) { setProblem(problemText(e, t)); } finally { setRunning(null); }
  };
  return { busy: running !== null, running, error, setError, run };
}

/** Saves a wallet's backup file: the desktop app asks where (false when the person cancelled), a browser downloads it. */
export const downloadJson = async (text: string, name: string): Promise<boolean> =>
  (await saveMade(servicesPlatform, new Blob([text], { type: "application/json" }), name)) !== "cancelled";
