import { useState } from "react";
import { errorText } from "../../lib/errorText";
import { useT } from "../../contexts/I18nContext";
import { saveMade } from "../../lib/fileDownload";
import { servicesPlatform } from "../../lib/platform";

/** Runs one wallet operation at a time and keeps its error. */
export function useRun() {
  const t = useT();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(errorText(e, t)); } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

/** Saves a wallet's backup file: the desktop app asks where (false when the person cancelled), a browser downloads it. */
export const downloadJson = async (text: string, name: string): Promise<boolean> =>
  (await saveMade(servicesPlatform, new Blob([text], { type: "application/json" }), name)) !== "cancelled";
