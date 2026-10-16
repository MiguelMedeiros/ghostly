import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useBackdropDismiss } from "../../hooks/useDismiss";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { useIsLocked } from "../../contexts/LockScreenContext";
import { CONTACT_LINK_EVENT, adoptEngineChat, takeContactLink } from "../../lib/contactLinks";
import { useEngineState } from "../../lib/engineState";
import { problemLine } from "../../lib/problemText";
import { chatPath } from "../../lib/url";
import { Notice } from "../ui/Notice";

const TEXT_BYTES = 200;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * Someone's contact link, opened or pasted (WISP 8xx): a form for a request, never a chat by itself. The person says
 * their name and a short message, and may name the chat on this side; Send puts the request out, and the chat made for
 * it waits for an answer in the chat list. A link of this profile's own, a link turned off or busy, is said here in
 * the engine's words.
 */
export function ContactAskHost() {
  const isLocked = useIsLocked();
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    const take = () => { const value = takeContactLink(); if (value) setCode(value); };
    take();
    window.addEventListener(CONTACT_LINK_EVENT, take);
    return () => window.removeEventListener(CONTACT_LINK_EVENT, take);
  }, []);
  // Asked once the lock is passed: the form is the person's, not the page's that sent them here.
  if (!code || isLocked) return null;
  return <ContactAskDialog key={code} code={code} onClose={() => setCode(null)} />;
}

export function ContactAskDialog({ code, onClose }: { code: string; onClose(): void }) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const nick = useEngineState()?.settings.nick ?? "";
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(nick);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const used = bytes(text.trim());
  const ready = !!name.trim() && !!text.trim() && used <= TEXT_BYTES && !busy;
  const send = () => {
    if (!ready) return;
    setBusy(true); setError("");
    void engine.call("askContactLink", { code, name: name.trim(), text: text.trim(), ...(label.trim() ? { label: label.trim() } : {}) })
      .then(({ chatId }) => adoptEngineChat(chatId))
      .then((id) => { onClose(); nav.conversation(chatPath(id)); })
      .catch((e) => { setError(problemLine(e, t)); setBusy(false); });
  };
  const field = "w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <dialog ref={dialog} {...backdrop} data-testid="contact-ask" onCancel={(event) => { event.preventDefault(); onClose(); }} aria-labelledby="contact-ask-title"
      className="m-auto w-[calc(100%_-_2rem)] max-w-sm max-h-[85dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="contact-ask-title" className="font-semibold">{t("requests.askTitle")}</h2>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="h-10 w-10 cursor-pointer rounded-lg text-xl hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">×</button>
      </div>
      <p className="mb-4 text-sm text-text-secondary">{t("requests.askLead")}</p>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <label className="block space-y-1 text-xs font-medium text-text-secondary">
          <span>{t("requests.askName")}</span>
          <input data-testid="contact-ask-name" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} className={field} autoComplete="nickname" />
        </label>
        <label className="block space-y-1 text-xs font-medium text-text-secondary">
          <span>{t("requests.askText")}</span>
          <textarea data-testid="contact-ask-text" value={text} rows={3} onChange={(e) => setText(e.target.value)} className={`${field} resize-none`} autoFocus />
          <span className={`block text-end tabular-nums ${used > TEXT_BYTES ? "text-danger" : "text-text-muted"}`} data-testid="contact-ask-left">{t("requests.askLeft", { count: TEXT_BYTES - used })}</span>
        </label>
        <label className="block space-y-1 text-xs font-medium text-text-secondary">
          <span>{t("requests.askLabel")}</span>
          <input data-testid="contact-ask-label" value={label} maxLength={48} onChange={(e) => setLabel(e.target.value)} className={field} />
        </label>
        <p className="text-xs text-text-muted">{t("requests.askPrivate")}</p>
        {error && <Notice tone="error" testId="contact-ask-error">{error}</Notice>}
        <button type="submit" data-testid="contact-ask-send" disabled={!ready} aria-busy={busy || undefined}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-on-accent cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
          {t("requests.askSend")}
        </button>
      </form>
    </dialog>
  );
}
