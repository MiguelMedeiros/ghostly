"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Ghost } from "@/components/ghost/Ghost";
import { Icon } from "@/components/site/icons";
import { APP_URL } from "@/content/shell";
import { join } from "@/content/join";
import { checkInvite, type InviteCheck } from "@/lib/invite";
import { href, type Locale } from "@/lib/i18n";
import "@/app/join.css";

declare global {
  interface Window {
    /** The invite a visit to ghostly.tools/#ghostly1… carried, taken out of the address before any other script ran (app/layout.tsx). */
    __ghostlyInvite?: string;
  }
}

/** The layout's script says `ghostly-invite` when it takes one; closing says it too. */
const subscribe = (changed: () => void) => {
  window.addEventListener("ghostly-invite", changed);
  return () => window.removeEventListener("ghostly-invite", changed);
};
/** On the client only: the server never sees the fragment, so it renders nothing here. */
const taken = () => window.__ghostlyInvite ?? null;

/**
 * The join page (WISP 801, Q11). A link `https://ghostly.tools/#ghostly1…` lands on the site; the code
 * travels in the fragment, which no browser sends to a server. A script in the layout takes it out of
 * the address before analytics load; this dialog reads it and offers the ways to open it.
 */
export function JoinLanding({ locale }: { locale: Locale }) {
  const invite = useSyncExternalStore(subscribe, taken, () => null);
  if (!invite) return null;
  return <JoinDialog key={invite} locale={locale} check={checkInvite(invite)} />;
}

function JoinDialog({ locale, check }: { locale: Locale; check: InviteCheck }) {
  const t = join[locale];
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  const close = () => {
    dialog.current?.close();
    delete window.__ghostlyInvite;
    window.dispatchEvent(new Event("ghostly-invite"));
  };
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <dialog ref={dialog} className="join-dialog card" aria-labelledby="join-title" data-testid="join-landing" onClose={close}>
      <button type="button" className="join-close" aria-label={t.close} onClick={close}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      <div className="join-ghost" aria-hidden="true">
        <Ghost who="boo" size={88} mood={check.ok ? "happy" : "surprised"} />
      </div>
      {check.ok ? (
        <>
          <h2 id="join-title" className="join-title">{t.title}</h2>
          <p className="join-lead">{t.lead}</p>
          <div className="join-actions">
            <a className="btn btn--primary" href={`${APP_URL}/#${check.code}`} rel="noreferrer" data-testid="join-browser" autoFocus>
              <Icon name="globe" /> {t.browser}
            </a>
            <button type="button" className="btn" onClick={() => void copy(check.code)} data-testid="join-desktop">
              <Icon name="desktop" /> {t.desktop}
            </button>
            {copied === "yes" && <p role="status" className="join-note">{t.desktopCopied}</p>}
            {copied === "failed" && (
              <p role="status" className="join-note">
                {t.desktopCopyFailed} <code className="join-code">{check.code}</code>
              </p>
            )}
            <a className="btn" href={`${href(locale, "/")}#download`} onClick={close} data-testid="join-download">
              <Icon name="download" /> {t.download}
            </a>
          </div>
          <p className="caption join-private">{t.private}</p>
        </>
      ) : (
        <>
          <h2 id="join-title" className="join-title">{t.refusedTitle}</h2>
          <p role="alert" className="join-lead" data-testid="join-refused">{t.refused[check.reason]}</p>
          <div className="join-actions">
            <a className="btn" href={`${href(locale, "/")}#download`} onClick={close} autoFocus>
              <Icon name="download" /> {t.download}
            </a>
          </div>
        </>
      )}
    </dialog>
  );
}
