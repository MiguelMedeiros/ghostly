import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { appFingerprint, appRefPublisher, type AppCard } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { usePlatformValue } from "../../hooks/useServicesPlatform";
import { servicesPlatform } from "../../lib/platform";
import { Button } from "../wallet/ui";
import { AppIcon, Fingerprint } from "./AppIcon";
import { AppInstallDialog, InstalledAppDialog } from "./AppInstallDialog";
import { NAME, aroundName, withName } from "./aroundName";
import { appStopped, refreshInstalledApps, useInstalledApp } from "../../lib/apps/installed";
import { appsBlock, appsUnavailable } from "../../lib/apps/availability";
import { openApp } from "../../lib/apps/open";
import { appErrorText } from "../../lib/apps/errors";
import { ownDirection } from "../../lib/ownDirection";

/*
 * An app card in a 1:1 chat (WISP 405 § An app, WISP 1200 § Apps sent in a chat): "Ana opened Chess", drawn from its
 * own data and nothing else. Every field is the sender's claim: the title and version as the sender's, a generic icon,
 * the publisher's fingerprint from `ref`, "Not checked yet". Nothing is fetched to show it: the bundle is fetched,
 * checked and shown on the install screen only when the person presses Join (not "Install": the card invites the person
 * into the app their contact opened), and installing opens it in
 * this chat. Once the app is installed here, the card says Open and names the installed app (its checked title, version
 * and icon), whatever the card calls it. While the contact is not live it says the app needs
 * you both online, unless the app is stopped with nothing that could run it. A version found revoked or removed says "Stopped" with no Open, as the Apps page and the composer's
 * Apps do (`appStopped`); one a store of the person's removed offers "Run anyway" (WISP 1200 § Takedowns), which a
 * revoked one never gets. The card is the contact's, so its Run anyway runs nothing: it opens the installed app's
 * details screen, the Apps page's, which says which store removed it and why before its own Run anyway.
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
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open on its way: an app whose files are missing here (a restored profile) fetches them first, which a slow link
  // makes long. The pressed button turns busy so the press shows, and a second press opens nothing more.
  const [opening, setOpening] = useState<"open" | "anyway" | null>(null);
  const app = useInstalledApp(card.ref);
  // The details screen goes with the app, uninstalled on it or elsewhere (the Apps page, another card of it): it is no
  // longer chosen, or it would open again by itself once the app is installed again.
  if (details && !app) setDetails(false);
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
  // The app went while the focus was on the details screen its Run anyway opened (or on that screen's Uninstall
  // question): uninstalled there, or elsewhere meanwhile. That button went with the app, and the screen gave the focus
  // back to nothing. The card's Join (or its line saying to ask for a link) has it, not the page; never taken from where
  // the person went meanwhile (the Apps page's own screen, where its Uninstall gives the focus to its Add). The screen
  // is drawn over the window, outside the card's element, but its focus events reach the card through React.
  const detailsHadFocus = useRef(false);
  const focusIn = (e: FocusEvent<HTMLDivElement>) => { detailsHadFocus.current = details && !e.currentTarget.contains(e.target); };
  const focusOut = (e: FocusEvent<HTMLDivElement>) => { if (e.relatedTarget) detailsHadFocus.current = false; };
  const joinRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!detailsHadFocus.current || details || app) return;
    detailsHadFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) (joinRef.current ?? askRef.current)?.focus({ preventScroll: true });
  });
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
  // A stopped app with no Run anyway runs nowhere: being online would not open it, so no line says it waits for that.
  const runAnyway = app?.run.status === "removed";
  const waiting = stopped && !runAnyway ? null : appsUnavailable(block, title, contact, t);
  // A blocked contact's card says so, and neither Open nor Join goes: their app frames are dropped, so the app would
  // wait for them for good.
  const open = (runAnyway = false) => {
    if (opening) return;
    setError(null); setOpening(runAnyway ? "anyway" : "open");
    const lacked = app?.run.status === "needs-files";
    // Refused (removed or revoked since the list was read): the list is read again first, so the card says Stopped,
    // and offers Run anyway only for a store's removal, as the Apps page then does.
    void openApp(card.ref, linkId, { runAnyway })
      // Opening is what fetched its files (a restored profile): every screen's list says so, and the icon shows.
      .then(() => { if (lacked) void refreshInstalledApps(); }, async (e: unknown) => { await refreshInstalledApps(); setError(appErrorText(e, t)); })
      .finally(() => setOpening(null));
  };
  return (
    <div className="px-3 py-2.5 space-y-2" data-testid="app-card" data-ref={card.ref} onFocus={focusIn} onBlur={focusOut}>
      <div className="flex items-start gap-3">
        <AppIcon size={40} installed={app} />
        <div className="min-w-0 flex-1">
          {/* A long title is cut alone: the version stays whole after it, the one a contact opened or this app has. A
              version too long for half the line ("1.2.0-beta.3+20261106.a1b2c3d") is cut at its end instead, or it took
              the title's place. The row goes the page's way, from the icon; the title and version read in their own. */}
          <p className="flex items-baseline gap-1 chat-text-card-title font-medium text-text-primary" data-testid="app-card-title">
            <span dir="auto" className="truncate min-w-0">{title}</span>
            {version && <>{" "}<span dir="ltr" className="shrink-0 max-w-[50%] truncate">{version}</span></>}
          </p>
          <p data-testid="app-card-who" className={`chat-text-card-line text-text-secondary ${mine ? "truncate" : "flex min-w-0 overflow-hidden whitespace-nowrap"}`}>{who}</p>
          <p className="flex flex-wrap items-center gap-x-2 chat-text-card-line text-text-muted">
            <Fingerprint value={appFingerprint(appRefPublisher(card.ref))} size="chat-text-card-note" />
            <span ref={checkRef} tabIndex={stopped ? -1 : undefined} data-testid="app-card-check" className={stopped ? "text-danger-ink" : undefined}>{stopped ? t("apps.app.stopped") : app ? t("apps.card.installed") : t("apps.card.notChecked")}</span>
          </p>
        </div>
      </div>
      {waiting && <p className="chat-text-card-line text-text-secondary" data-testid="app-card-waiting">{waiting}</p>}
      {error && <p role="alert" dir={ownDirection(error)} className="chat-text-card-line text-danger-ink" data-testid="app-card-error">{error}</p>}
      <div className="flex items-center gap-2">
        {stopped ? null : app ? <Button ref={openRef} variant="primary" data-testid="app-card-open" disabled={block === "blocked"} loading={opening === "open"} onClick={() => open()}>{t("apps.page.open")}</Button>
          : card.url ? <Button ref={joinRef} variant="primary" data-testid="app-card-install" disabled={block === "blocked"} onClick={() => setInstalling(true)}>{t("apps.card.join")}</Button>
            : <span ref={askRef} tabIndex={-1} className="chat-text-card-line text-text-muted" data-testid="app-card-ask">{mine ? t("apps.card.noLink") : withName(t("apps.card.ask", { name: NAME }), contact)}</span>}
        {runAnyway && <Button ref={runAnywayRef} data-testid="app-card-run-anyway" loading={opening === "anyway"} onClick={() => setDetails(true)}>{t("apps.app.runAnyway")}</Button>}
        <span className="ms-auto flex items-center gap-1 text-[11px] text-text-muted">{time}{marks}</span>
      </div>
      {installing && card.url && (
        <AppInstallDialog source={{ card: { ref: card.ref, url: card.url, sequence: card.sequence, digest: card.digest } }} title={card.title}
          sentBy={mine ? undefined : contact} openAfter onClose={() => setInstalling(false)} onInstalled={() => open()} />
      )}
      {details && app && <InstalledAppDialog app={app} onClose={() => setDetails(false)} onOpen={(_app, options) => open(options?.runAnyway === true)} />}
    </div>
  );
}
