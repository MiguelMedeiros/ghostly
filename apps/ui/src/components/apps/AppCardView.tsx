import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { appFingerprint, appRefPublisher, type AppCard } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { usePlatformValue } from "../../hooks/useServicesPlatform";
import { servicesPlatform } from "../../lib/platform";
import { Button } from "../wallet/ui";
import { AppIcon, Fingerprint } from "./AppIcon";
import { AppInstallDialog } from "./AppInstallDialog";
import { NAME, aroundName } from "./aroundName";
import { appStopped, refreshInstalledApps, useInstalledApp } from "../../lib/apps/installed";
import { appsBlock, appsUnavailable } from "../../lib/apps/availability";
import { openApp } from "../../lib/apps/open";
import { appErrorText } from "../../lib/apps/errors";

/*
 * An app card in a 1:1 chat (WISP 405 § An app, WISP 1200 § Apps sent in a chat): "Ana opened Chess", drawn from its
 * own data and nothing else. Every field is the sender's claim: the title and version as the sender's, a generic icon,
 * the publisher's fingerprint from `ref`, "Not checked yet". Nothing is fetched to show it: the bundle is fetched,
 * checked and shown on the install screen only when the person presses Join (not "Install": the card invites the person
 * into the app their contact opened), and installing opens it in
 * this chat. Once the app is installed here, the card says Open and names the installed app (its checked title, version
 * and icon), whatever the card calls it. While the contact is not live it says the app needs
 * you both online. A version found revoked or removed says "Stopped" with no Open, as the Apps page and the composer's
 * Apps do (`appStopped`); one a store of the person's removed offers "Run anyway" (WISP 1200 § Takedowns), which a
 * revoked one never gets.
 */
export function AppCardView({ card, mine, contact, linkId, peerKey, time, marks }: {
  card: AppCard;
  /** The card is mine (I opened or shared it). */
  mine: boolean;
  /** The contact's name, as the chat shows it. */
  contact: string;
  linkId: string;
  peerKey: string;
  time?: ReactNode;
  marks?: ReactNode;
}) {
  const { t } = useI18n();
  // Only whether the app can talk to the contact's now: a card is not drawn again on every engine state, up to 20 a
  // second while a file moves, which the bubble's memo exists to spare a long chat.
  const block = usePlatformValue(() => appsBlock(servicesPlatform?.getPeer(peerKey)));
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open on its way: an app whose files are missing here (a restored profile) fetches them first, which a slow link
  // makes long. The pressed button turns busy so the press shows, and a second press opens nothing more.
  const [opening, setOpening] = useState<"open" | "anyway" | null>(null);
  const app = useInstalledApp(card.ref);
  // A refused Open's line is of the app as it was: once the installed app reads otherwise (a store allows it again,
  // its publisher revokes it), the card says what the Apps page says, not the old refusal.
  const [errorOf, setErrorOf] = useState(app);
  if (errorOf !== app) { setErrorOf(app); setError(null); }
  const stopped = !!app && appStopped(app);
  // Open goes when the app stops (found revoked or removed, often by an update check): its focus would drop to the
  // page. The ref's cleanup runs while the button is still there. The focus stays on the card: on Run anyway when it
  // is offered, else on the "Stopped" it now says, never taken from where the person went meanwhile.
  const openHadFocus = useRef(false);
  const openRef = useCallback((button: HTMLButtonElement) => () => { openHadFocus.current = document.activeElement === button; }, []);
  const runAnywayRef = useRef<HTMLButtonElement>(null);
  const checkRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!openHadFocus.current) return;
    openHadFocus.current = false;
    const active = document.activeElement;
    if (stopped && (!active || active === document.body)) (runAnywayRef.current ?? checkRef.current)?.focus({ preventScroll: true });
  });
  // Installed here: the app's own checked title and version, the one Open starts, never the sender's words for it.
  const title = app ? app.title : card.title;
  const version = app ? app.version : card.version;
  // A long name is cut alone, never "opened it here" after it: a 20-letter nickname on a 320 px phone lost the words.
  const who = mine ? (card.opened ? t("apps.card.youOpened") : t("apps.card.youShared"))
    : aroundName(t(card.opened ? "apps.card.opened" : "apps.card.shared", { name: NAME }), contact, "app-card-name");
  const waiting = appsUnavailable(block, title, contact, t);
  const open = (runAnyway = false) => {
    if (opening) return;
    setError(null); setOpening(runAnyway ? "anyway" : "open");
    // Refused (removed or revoked since the list was read): the list is read again first, so the card says Stopped,
    // and offers Run anyway only for a store's removal, as the Apps page then does.
    void openApp(card.ref, linkId, { runAnyway }).catch(async (e: unknown) => { await refreshInstalledApps(); setError(appErrorText(e, t)); })
      .finally(() => setOpening(null));
  };
  return (
    <div className="px-3 py-2.5 space-y-2" data-testid="app-card" data-ref={card.ref}>
      <div className="flex items-start gap-3">
        <AppIcon size={40} installed={app} />
        <div className="min-w-0 flex-1">
          {/* A long title is cut alone: the version stays whole after it, the one a contact opened or this app has. A
              version too long for half the line ("1.2.0-beta.3+20261106.a1b2c3d") is cut at its end instead, or it took
              the title's place. The row goes the page's way, from the icon; the title and version read in their own. */}
          <p className="flex items-baseline gap-1 text-sm font-medium text-text-primary" data-testid="app-card-title">
            <span dir="auto" className="truncate min-w-0">{title}</span>
            {version && <>{" "}<span dir="ltr" className="shrink-0 max-w-[50%] truncate">{version}</span></>}
          </p>
          <p data-testid="app-card-who" className={`text-xs text-text-secondary ${mine ? "truncate" : "flex min-w-0 overflow-hidden whitespace-nowrap"}`}>{who}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
            <Fingerprint value={appFingerprint(appRefPublisher(card.ref))} />
            <span ref={checkRef} tabIndex={stopped ? -1 : undefined} data-testid="app-card-check" className={stopped ? "text-danger-ink" : undefined}>{stopped ? t("apps.app.stopped") : app ? t("apps.card.installed") : t("apps.card.notChecked")}</span>
          </p>
        </div>
      </div>
      {waiting && <p className="text-xs text-text-secondary" data-testid="app-card-waiting">{waiting}</p>}
      {error && <p role="alert" className="text-xs text-danger" data-testid="app-card-error">{error}</p>}
      <div className="flex items-center gap-2">
        {stopped ? null : app ? <Button ref={openRef} variant="primary" data-testid="app-card-open" loading={opening === "open"} onClick={() => open()}>{t("apps.page.open")}</Button>
          : card.url ? <Button variant="primary" data-testid="app-card-install" onClick={() => setInstalling(true)}>{t("apps.card.join")}</Button>
            : <span className="text-xs text-text-muted" data-testid="app-card-ask">{mine ? t("apps.card.noLink") : t("apps.card.ask", { name: contact })}</span>}
        {app?.run.status === "removed" &&<Button ref={runAnywayRef} data-testid="app-card-run-anyway" loading={opening === "anyway"} onClick={() => open(true)}>{t("apps.app.runAnyway")}</Button>}
        <span className="ms-auto flex items-center gap-1 text-[11px] text-text-muted">{time}{marks}</span>
      </div>
      {installing && card.url && (
        <AppInstallDialog source={{ card: { ref: card.ref, url: card.url, sequence: card.sequence, digest: card.digest } }} title={card.title}
          sentBy={mine ? undefined : contact} openAfter onClose={() => setInstalling(false)} onInstalled={() => open()} />
      )}
    </div>
  );
}
