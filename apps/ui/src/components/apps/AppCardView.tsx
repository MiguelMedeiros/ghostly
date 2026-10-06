import { useState, type ReactNode } from "react";
import { appFingerprint, appRefPublisher, type AppCard } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { useServicesPlatform } from "../../hooks/useServicesPlatform";
import { Button } from "../wallet/ui";
import { AppIcon, Fingerprint } from "./AppIcon";
import { AppInstallDialog } from "./AppInstallDialog";
import { useInstalledApps } from "../../lib/apps/installed";
import { appsUnavailable } from "../../lib/apps/availability";
import { openApp } from "../../lib/apps/open";
import { appErrorText } from "../../lib/apps/errors";

/*
 * An app card in a 1:1 chat (WISP 405 § An app, WISP 1200 § Apps sent in a chat): "Ana opened Chess", drawn from its
 * own data and nothing else. Every field is the sender's claim: the title and version as the sender's, a generic icon,
 * the publisher's fingerprint from `ref`, "Not checked yet". Nothing is fetched to show it: the bundle is fetched,
 * checked and shown on the install screen only when the person presses "Install to play", and installing opens it in
 * this chat. Once the app is installed here, the card says Play. While the contact is not live it says the app needs
 * you both online.
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
  const installed = useInstalledApps(true);
  const platform = useServicesPlatform();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const app = installed?.find((a) => a.ref === card.ref);
  const named = card.version ? `${card.title} ${card.version}` : card.title;
  const who = mine ? (card.opened ? t("apps.card.youOpened") : t("apps.card.youShared"))
    : card.opened ? t("apps.card.opened", { name: contact }) : t("apps.card.shared", { name: contact });
  const waiting = appsUnavailable(platform?.getPeer(peerKey), card.title, contact, t);
  const play = () => { setError(null); void openApp(card.ref, linkId).catch((e: unknown) => setError(appErrorText(e, t))); };
  return (
    <div className="px-3 py-2.5 space-y-2" data-testid="app-card" data-ref={card.ref}>
      <div className="flex items-start gap-3">
        <AppIcon size={40} installed={app} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary truncate" data-testid="app-card-title">{named}</p>
          <p className="text-xs text-text-secondary truncate">{who}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
            <Fingerprint value={appFingerprint(appRefPublisher(card.ref))} />
            <span data-testid="app-card-check">{app ? t("apps.card.installed") : t("apps.card.notChecked")}</span>
          </p>
        </div>
      </div>
      {waiting && <p className="text-xs text-text-secondary" data-testid="app-card-waiting">{waiting}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        {app ? <Button variant="primary" data-testid="app-card-play" onClick={play}>{t("apps.card.play")}</Button>
          : card.url ? <Button variant="primary" data-testid="app-card-install" onClick={() => setInstalling(true)}>{t("apps.card.install")}</Button>
            : <span className="text-xs text-text-muted" data-testid="app-card-ask">{mine ? t("apps.card.noLink") : t("apps.card.ask", { name: contact })}</span>}
        <span className="ms-auto flex items-center gap-1 text-[11px] text-text-muted">{time}{marks}</span>
      </div>
      {installing && card.url && (
        <AppInstallDialog source={{ card: { ref: card.ref, url: card.url, sequence: card.sequence, digest: card.digest } }} title={card.title}
          sentBy={mine ? undefined : contact} playAfter onClose={() => setInstalling(false)} onInstalled={() => play()} />
      )}
    </div>
  );
}
