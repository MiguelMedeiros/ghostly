import { useState } from "react";
import { problemText, type Problem } from "../../lib/problemText";
import { useT } from "../../contexts/I18nContext";
import { saveMade } from "../../lib/fileDownload";
import { servicesPlatform } from "../../lib/platform";

/**
 * Runs one wallet operation at a time and keeps its error, as a notice says it (lib/problemText.ts): a few words, the
 * engine's English behind the ⓘ. `setError` takes a line of the app's own ("" clears it).
 */
export function useRun() {
  const t = useT();
  const [busy, setBusy] = useState(false), [error, setProblem] = useState<Problem | null>(null);
  const setError = (text: string) => setProblem(text ? { tone: "error", title: text } : null);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setProblem(null);
    try { await work(); } catch (e) { setProblem(problemText(e, t)); } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

/** Saves a wallet's backup file: the desktop app asks where (false when the person cancelled), a browser downloads it. */
export const downloadJson = async (text: string, name: string): Promise<boolean> =>
  (await saveMade(servicesPlatform, new Blob([text], { type: "application/json" }), name)) !== "cancelled";
