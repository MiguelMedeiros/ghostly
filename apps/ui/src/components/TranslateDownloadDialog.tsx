import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../contexts/I18nContext";
import { languageName, languageTag } from "../lib/documentLanguage";
import type { Problem } from "../lib/problemText";
import { sizeIn } from "../lib/sizeText";
import { translateEnabled } from "../lib/translateFlag";
import { Notice } from "./ui/Notice";

interface Question {
  /** The pair's languages, as ISO 639 codes. */
  from: string;
  to: string;
  /** Both ways: `from` to `to`, and `to` to `from`. */
  back: boolean;
  /** What it downloads (`downloadBytes`). */
  bytes: number;
  /** The translation runtime comes with it. */
  engine: boolean;
  /** Download was pressed and the files are on their way. */
  busy?: boolean;
  /** Why the last Download did not finish. */
  problem?: Problem | null;
  onNotNow(): void;
  onDownload(): void;
}

/**
 * Asked before languages download for translation (docs/AUTO-TRANSLATE.md § Model download): which ones, how big, and
 * whose servers see the request. Nothing downloads without Download; Not now has the focus, so Enter and Escape leave
 * it, and once it downloads they close the question with the download going on. Nothing at all in a build without
 * translation (`VITE_TRANSLATE`).
 */
export function TranslateDownloadDialog(props: Question) {
  return translateEnabled() ? <DownloadQuestion {...props} /> : null;
}

function DownloadQuestion({ from, to, back, bytes, engine, busy = false, problem, onNotNow, onDownload }: Question) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), notNow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    notNow.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  const language = t.language ?? "en";
  const pair = t(back ? "translate.download.pairBack" : "translate.download.pair", {
    from: languageName(from, language),
    to: languageName(to, language),
    size: sizeIn(Math.max(1, Math.round(bytes / 1024 / 1024)), "mb", t),
  });
  // A name that starts the line starts with a capital: "Portugais vers anglais".
  const line = pair.charAt(0).toLocaleUpperCase(languageTag(language)) + pair.slice(1);

  // Tab stays in the question: its buttons, and the failure's ⓘ when there is one.
  const cycle = (back: boolean) => {
    const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (back ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(<dialog ref={dialog} role="alertdialog" data-testid="translate-download"
    onCancel={(e) => { e.preventDefault(); onNotNow(); }}
    onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); cycle(e.shiftKey); } }}
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">{t("translate.download.title")}</h2>
    <p data-testid="translate-download-pair" className="mt-2 text-sm font-medium">{line}</p>
    <div id={`${id}-body`} className="mt-2 space-y-2 text-sm text-text-muted">
      <p>{t("translate.download.body")}</p>
      {engine && <p data-testid="translate-download-engine">{t("translate.download.engine")}</p>}
    </div>
    {busy && <p role="status" data-testid="translate-download-goes-on" className="mt-2 text-sm text-text-muted">{t("translate.download.goesOn")}</p>}
    {problem && <Notice problem={problem} testId="translate-download-failed" className="mt-3 text-sm" />}
    <div className="mt-5 flex justify-end gap-2">
      <button ref={notNow} type="button" data-testid="translate-download-not-now" onClick={onNotNow}
        className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t(busy ? "common.close" : "translate.download.notNow")}</button>
      <button type="button" data-testid="translate-download-yes" onClick={onDownload} disabled={busy} aria-busy={busy}
        className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60">{t("translate.download.download")}</button>
    </div>
  </dialog>, document.body);
}
