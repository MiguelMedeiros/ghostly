import { useState } from "react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

const LINK_LABEL = {
  idle: "",
  offering: "Connecting…",
  answering: "Connecting…",
  connecting: "Connecting…",
  open: "Peer to peer",
} as const;

/**
 * The chat's apps strip: what this contact lets you open, and how many of your apps you let them
 * open, with the way to change it. `showLink`: also the state of an older chat's data link.
 */
export function PeerServices({ peerPubKey, showLink = true, onManage }: { peerPubKey: string; showLink?: boolean; onManage: () => void }) {
  const platform = useServicesPlatform();
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
          title="Messages, calls and services travel directly between the two of you over WebRTC">
          <span className={`w-1.5 h-1.5 rounded-full ${peer.dataLink === "open" ? "bg-accent" : "bg-yellow-500 animate-pulse"}`} />
          {LINK_LABEL[peer.dataLink]}
        </span>
      )}
      {services.length > 0 && <span className="text-[11px] text-text-muted shrink-0">Apps you can open:</span>}
      {services.map((service) => (
        <button key={service.id} data-testid="open-service"
          onClick={() => {
            setError("");
            if (!platform.features.openServices) { setError("Opening a contact's web app needs the Ghostly browser extension or desktop app."); return; }
            platform.openService(peerPubKey, service.id).catch((e) => setError(e instanceof Error ? e.message : String(e)));
          }}
          className="flex items-center gap-1.5 px-3 py-1 bg-accent text-[#111b21] rounded-full text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer shrink-0"
          title={`Open ${service.name ?? service.id}, served from your contact's machine`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
          {service.name ?? service.id}
        </button>
      ))}
      <button data-testid="grant-services" onClick={onManage} className="ml-auto flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text-primary transition-colors cursor-pointer shrink-0"
        title="Choose which of your local apps this contact can open">
        {granted.length > 0 ? `You share ${granted.length} ${granted.length === 1 ? "app" : "apps"}` : "Share an app"} · Manage
      </button>
      {error && <span className="text-danger text-xs shrink-0 w-full">{error}</span>}
    </div>
  );
}
