"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Ghost } from "@/components/ghost/Ghost";
import { Icon } from "@/components/site/icons";
import { APP_URL } from "@/content/shell";
import { join } from "@/content/join";
import { checkInvite, type InviteCheck } from "@/lib/invite";
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
 * the address before any other script runs; this dialog reads it and, unless this device chose the Ghostly app
 * before, counts down and opens it in the web app (a scanned QR opens the chat with no tap), with Cancel
 * and the other ways to open it.
 */
export function JoinLanding() {
  const invite = useSyncExternalStore(subscribe, taken, () => null);
  if (!invite) return null;
  return <JoinDialog key={invite} check={checkInvite(invite)} />;
}

/** How long the page counts down before it opens the chat in the web app. Long enough to read and cancel. */
export const GO_SECONDS = 3;

/**
 * Where this device opens invites. Someone who chose the Ghostly app once is not sent to the web app
 * again; choosing the browser forgets it. Only the choice is kept, never an invite.
 */
const CHOICE_KEY = "ghostly.join.open";
// Where storage is refused (private windows, blocked site data) the choice lasts as long as the page.
let memory: "app" | null = null;

function remembered(): "app" | null {
  try {
    return localStorage.getItem(CHOICE_KEY) === "app" ? "app" : null;
  } catch {
    return memory;
  }
}

function remember(choice: "app" | null) {
  memory = choice;
  try {
    if (choice) localStorage.setItem(CHOICE_KEY, choice);
    else localStorage.removeItem(CHOICE_KEY);
  } catch {
    // Kept in memory only.
  }
}

function JoinDialog({ check }: { check: InviteCheck }) {
  const t = join;
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  // Mounted on the client only (JoinLanding renders nothing on the server), so storage is readable here.
  const [preferApp] = useState(() => remembered() === "app");
  // Seconds left before the web app opens; null once cancelled, or when it never counts (a refusal, or the app is preferred).
  const [left, setLeft] = useState<number | null>(() => (check.ok && !preferApp ? GO_SECONDS : null));
  const href = check.ok ? `${APP_URL}/#${check.code}` : "";
  const counting = left !== null;
  // The dialog's own focusing steps want an `autofocus` attribute, which React never writes: the element
  // marked data-autofocus takes the focus on opening, and again when the countdown gives way to the choices.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    element?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [counting]);
  useEffect(() => {
    if (left === null) return;
    // replace, not a click on the link: nothing to record, and Back does not return here.
    // The code is only in the fragment, which no request carries.
    if (left === 0) {
      location.replace(href);
      return;
    }
    const timer = window.setTimeout(() => setLeft(left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left, href]);
  const close = () => {
    setLeft(null);
    dialog.current?.close();
    delete window.__ghostlyInvite;
    window.dispatchEvent(new Event("ghostly-invite"));
  };
  const copy = async (code: string) => {
    setLeft(null);
    remember("app");
    try {
      await navigator.clipboard.writeText(code);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };
  if (!check.ok) {
    return (
      <dialog ref={dialog} className="join-dialog card" aria-labelledby="join-title" data-testid="join-landing" onClose={close}>
        <CloseButton label={t.close} onClick={close} />
        <div className="join-ghost" aria-hidden="true">
          <Ghost who="boo" size={88} mood="surprised" />
        </div>
        <h2 id="join-title" className="join-title">{t.refusedTitle}</h2>
        <p role="alert" className="join-lead" data-testid="join-refused">{t.refused[check.reason]}</p>
        <div className="join-actions">
          <a className="btn" href={`${"/"}#download`} onClick={close} data-autofocus>
            <Icon name="download" /> {t.download}
          </a>
        </div>
      </dialog>
    );
  }
  const browser = (primary: boolean) => (
    <a className={primary ? "btn btn--primary" : "btn"} href={href} rel="noreferrer" data-testid="join-browser"
      onClick={() => remember(null)} data-autofocus={primary || undefined}>
      <Icon name="globe" /> {t.browser}
    </a>
  );
  const app = (primary: boolean) => (
    <button type="button" className={primary ? "btn btn--primary" : "btn"} onClick={() => void copy(check.code)}
      data-testid="join-desktop" data-autofocus={primary || undefined}>
      <Icon name="desktop" /> {t.desktop}
    </button>
  );
  const download = (
    <a className="btn" href={`${"/"}#download`} onClick={close} data-testid="join-download">
      <Icon name="download" /> {t.download}
    </a>
  );
  return (
    <dialog ref={dialog} className="join-dialog card" aria-labelledby="join-title" data-testid="join-landing" onClose={close}>
      <CloseButton label={t.close} onClick={close} />
      <div className="join-ghost" aria-hidden="true">
        <Ghost who="boo" size={88} mood="happy" />
      </div>
      <h2 id="join-title" className="join-title">{t.title}</h2>
      {counting ? (
        <>
          <div className="join-going" data-testid="join-going">
            {/* Said once; the number that ticks is for the eyes only. */}
            <p role="status" className="sr-only">{t.goingSaid(GO_SECONDS)}</p>
            <p className="join-going-text" aria-hidden="true">
              {t.going(left)}
            </p>
            <div className="join-going-bar" aria-hidden="true"><span style={{ animationDuration: `${GO_SECONDS}s` }} /></div>
          </div>
          <div className="join-actions join-actions--pair">
            <a className="btn btn--primary" href={href} rel="noreferrer" data-testid="join-go-now" onClick={() => remember(null)}>
              {t.goNow}
            </a>
            <button type="button" className="btn" onClick={() => setLeft(null)} data-testid="join-cancel" data-autofocus>
              {t.cancel}
            </button>
          </div>
          <p className="join-more">
            <button type="button" className="join-link" onClick={() => void copy(check.code)} data-testid="join-desktop">{t.desktop}</button>
            <span aria-hidden="true"> · </span>
            <a className="join-link" href={`${"/"}#download`} onClick={close} data-testid="join-download">{t.download}</a>
          </p>
        </>
      ) : (
        <>
          <p className="join-lead">{t.lead}</p>
          <div className="join-actions">
            {preferApp ? app(true) : browser(true)}
            {copied === "yes" && <p role="status" className="join-note">{t.desktopCopied}</p>}
            {copied === "failed" && (
              <p role="status" className="join-note">
                {t.desktopCopyFailed} <code className="join-code">{check.code}</code>
              </p>
            )}
            {preferApp ? browser(false) : app(false)}
            {download}
          </div>
        </>
      )}
      <p className="caption join-private">{t.private}</p>
    </dialog>
  );
}

function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="join-close" aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  );
}
