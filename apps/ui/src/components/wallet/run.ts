import { useState } from "react";

/** Runs one wallet operation at a time and keeps its error. */
export function useRun() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

export const downloadJson = (text: string, name: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
