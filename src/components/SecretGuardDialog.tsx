import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../contexts/I18nContext";
import type { SecretFinding } from "../lib/parse/secrets";

/**
 * Asked before the composer sends text that looks like a secret (`findSecret`): a seed or a private key, or a Cashu
 * token, which is money handed to whoever reads the chat. Cancel has the focus, so Enter and Escape keep the draft.
 * It says what kind of secret it is and, for ecash, how much: never the text itself.
 */
export function SecretGuardDialog({ finding, recipient, onCancel, onConfirm }: {
  finding: SecretFinding; recipient?: string; onCancel(): void; onConfirm(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  const contact = recipient || t("secretGuard.thisChat");
  let title: string, body: string;
  if (finding.kind === "cashu") {
    const { amount, unit } = finding;
    const worth = amount === null ? null : unit === "sat" ? t(amount === 1 ? "secretGuard.sat" : "secretGuard.sats", { count: amount.toLocaleString() }) : `${amount.toLocaleString()} ${unit.toUpperCase()}`;
    title = worth === null ? t("secretGuard.cashuUnknownTitle", { contact }) : t("secretGuard.cashuTitle", { amount: worth, contact });
    body = t("secretGuard.cashu");
  } else {
    const key = ({ mnemonic: "mnemonic", nsec: "nsec", "bitcoin-key": "bitcoinKey", "hex-key": "hexKey" } as const)[finding.kind];
    title = t(`secretGuard.${key}Title`);
    body = t(`secretGuard.${key}`);
  }

  return createPortal(<dialog ref={dialog} role="alertdialog" data-testid="secret-guard" data-kind={finding.kind}
    onCancel={(e) => { e.preventDefault(); onCancel(); }}
    onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); (document.activeElement === cancel.current ? confirm.current : cancel.current)?.focus(); } }}
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">{title}</h2>
    <p id={`${id}-body`} className="mt-2 text-sm text-text-muted">{body}</p>
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} type="button" data-testid="secret-guard-cancel" onClick={onCancel}
        className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button ref={confirm} type="button" data-testid="secret-guard-send" onClick={onConfirm}
        className="min-h-11 rounded-lg bg-danger/15 px-4 text-sm text-danger hover:bg-danger/25 focus-visible:ring-2 focus-visible:ring-danger">
        {t(finding.kind === "cashu" ? "secretGuard.send" : "secretGuard.sendAnyway")}
      </button>
    </div>
  </dialog>, document.body);
}
