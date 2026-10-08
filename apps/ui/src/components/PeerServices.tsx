import { useState } from "react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { problemLine } from "../lib/problemText";

/**
 * The chat's apps strip: what this contact lets you open, and how many of your apps you let them
 * open, with the way to change it. `showLink`: also the state of an older chat's data link.
 */
export function PeerServices({ peerPubKey, showLink = true, onManage }: { peerPubKey: string; showLink?: boolean; onManage: () => void }) {
  const platform = useServicesPlatform();
  const { t } = useI18n();
  const [error, setError] = useState("");
  const peer = platform?.getPeer(peerPubKey);
  if (!platform || !peer) return null;

  const services = (peer.services ?? []).filter((s) => s.type === "http");
  const mine = platform.features.shareLocalServices ? platform.getSharedServices() : [];
  const granted = mine.filter((s) => s.enabled && s.sharedWith?.includes(peerPubKey));
  if (services.length === 0 && granted.length === 0 && (!showLink || peer.dataLink === "idle")) return null;

  return (
    <div data-testid="peer-services" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-surface-alt border-b border-border shrink-0">
      {showLink && peer.dataLink !== "idle" && (
        <span data-testid="datalink-state" className={`flex items-center gap-1.5 text-[11px] shrink-0 ${peer.dataLink === "open" ? "text-accent" : "text-text-muted"}`}
          title={t("chat.services.p2pHint")}>
          <span className={`w-1.5 h-1.5 rounded-full ${peer.dataLink === "open" ? "bg-accent" : "bg-yellow-500 animate-pulse"}`} />
          {peer.dataLink === "open" ? t("chat.services.p2p") : t("connection.state.connectingDots")}
        </span>
      )}
      {services.length > 0 && <span className="text-[11px] text-text-muted shrink-0">{t("chat.services.canOpen")}</span>}
      {services.map((service) => (
        <button key={service.id} data-testid="open-service"
          onClick={() => {
            setError("");
            if (!platform.features.openServices) { setError(t("chat.services.openNeedsApp")); return; }
            platform.openService(peerPubKey, service.id).catch((e) => setError(problemLine(e, t)));
          }}
          className="flex items-center gap-1.5 px-3 py-1 bg-accent text-on-accent rounded-full text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer shrink-0"
          title={t("chat.services.openTheirs", { service: service.name ?? service.id })}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
          {service.name ?? service.id}
        </button>
      ))}
      <button data-testid="grant-services" onClick={onManage} className="ms-auto flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text-primary transition-colors cursor-pointer shrink-0"
        title={t("chat.services.manageHint")}>
        {granted.length === 1 ? t("chat.services.sharingOne") : granted.length > 0 ? t("chat.services.sharingMany", { count: granted.length }) : t("chat.services.shareOne")} · {t("chat.services.manage")}
      </button>
      {error && <span className="text-danger text-xs shrink-0 w-full">{error}</span>}
    </div>
  );
}
