import { useState } from "react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

const LINK_LABEL = {
  idle: "",
  offering: "Connecting…",
  answering: "Connecting…",
  connecting: "Connecting…",
  open: "Peer to peer",
} as const;

/** Strip under the chat header: the peer-to-peer link and the web apps this contact shares right now. */
export function PeerServices({ peerPubKey }: { peerPubKey: string }) {
  const platform = useServicesPlatform();
  const [error, setError] = useState("");
  const peer = platform?.getPeer(peerPubKey);
  if (!platform || !peer) return null;

  const services = (peer.services ?? []).filter((s) => s.type === "http");
  if (services.length === 0 && peer.dataLink === "idle") return null;

  return (
    <div
      data-testid="peer-services"
      className="flex items-center gap-2 px-4 py-2 bg-surface-alt border-b border-border shrink-0 overflow-x-auto"
    >
      {peer.dataLink !== "idle" && (
        <span
          data-testid="datalink-state"
          className={`flex items-center gap-1.5 text-[11px] shrink-0 ${peer.dataLink === "open" ? "text-accent" : "text-text-muted"}`}
          title="Messages, calls and services travel directly between the two of you over WebRTC"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${peer.dataLink === "open" ? "bg-accent" : "bg-yellow-500 animate-pulse"}`} />
          {LINK_LABEL[peer.dataLink]}
        </span>
      )}
      {services.map((service) => (
        <button
          key={service.id}
          data-testid="open-service"
          onClick={() => {
            setError("");
            platform.openService(peerPubKey, service.id).catch((e) => setError(e instanceof Error ? e.message : String(e)));
          }}
          className="flex items-center gap-1.5 px-3 py-1 bg-accent text-[#111b21] rounded-full text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer shrink-0"
          title={`Open ${service.name ?? service.id}, served from your contact's machine`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          {service.name ?? service.id}
        </button>
      ))}
      {error && <span className="text-danger text-xs shrink-0">{error}</span>}
    </div>
  );
}
