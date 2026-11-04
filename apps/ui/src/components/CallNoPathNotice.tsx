import type { IceServerSetting } from "@ghostly/browser/shared/types";
import { Link } from "react-router-dom";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useI18n } from "../contexts/I18nContext";
import { externalLinkProps } from "../lib/externalLink";
import { APP_WEBSITE } from "../lib/settings";

/** What to try when calls cannot get out of a network: a TURN server on 443, and how to set one (docs/CALLS-BLOCKED.md). */
export const CALLS_BLOCKED_GUIDE = `${APP_WEBSITE}/blob/main/docs/CALLS-BLOCKED.md`;

/**
 * Our call could not connect: ICE found no path to the contact (`useWebRTC`'s `noPath`). A VPN or firewall that blocks
 * UDP, or lets only TCP 443 out, does that, on either side; chats still go through the relays, calls need a TURN
 * server. The note says so, and points to where one is set (Settings, Network) and to the guide. It never says a VPN
 * was found: the app only sees that the call found no path. It stays until closed or the next call starts.
 * With a TURN server already set (`iceServers`, the profile's), the call failed through it too: the note says to check
 * it (its address, its credential, which a restored backup leaves out) or that the contact may need one, not to add one.
 */
export function CallNoPathNotice({ iceServers, onClose }: { iceServers?: readonly IceServerSetting[]; onClose: () => void }) {
  const { t } = useI18n();
  const turnSet = (iceServers ?? []).some((server) => server.urls.split(/[\s,]+/).some((url) => /^turns?:/i.test(url)));
  const nav = useAppNavigation();
  const link = "rounded text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <div role="alert" data-testid="call-no-path"
      className="top-notice flex items-start gap-3 rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-text-primary shadow-xl">
      <div className="min-w-0">
        <span className="block font-medium">{t("calls.noPath")}</span>
        <span className="block text-text-secondary">{t(turnSet ? "calls.noPathTurnSet" : "calls.noPathNext")}</span>
        <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <Link data-testid="call-no-path-settings" className={link} to="/settings/network"
            onClick={(e) => { e.preventDefault(); onClose(); nav.open("/settings/network"); }}>{t("calls.noPathSettings")}</Link>
          <a data-testid="call-no-path-guide" className={link} {...externalLinkProps(CALLS_BLOCKED_GUIDE)}>{t("calls.noPathGuide")}</a>
        </span>
      </div>
      <button type="button" data-testid="call-no-path-close" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
        className="relative grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent before:absolute before:-inset-3 before:content-['']">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
  );
}
