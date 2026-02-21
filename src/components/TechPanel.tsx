import { useState } from "react";
import type { ChatTechInfo, ConnectionStatus } from "../lib/types";

interface TechPanelProps {
  techInfo: ChatTechInfo;
  status: ConnectionStatus;
  lastSync: number | null;
  messageCount: number;
}

function TechRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-text-muted shrink-0">{label}</span>
      <span
        className={`text-text-secondary text-right break-all ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function CopyableRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-text-muted shrink-0">{label}</span>
      <button
        onClick={handleCopy}
        className="text-text-secondary text-right break-all font-mono bg-transparent border-none cursor-pointer hover:text-accent transition-colors text-[10px] p-0"
        title="Click to copy"
      >
        {copied ? "Copied!" : value}
      </button>
    </div>
  );
}

export function TechPanel({
  techInfo,
  status,
  lastSync,
  messageCount,
}: TechPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-border shrink-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-4 py-1 bg-surface-alt/50 text-[11px] text-text-muted hover:bg-surface-hover/50 transition-colors cursor-pointer border-none"
      >
        <span className="text-accent/70">{isOpen ? "▼" : "▶"}</span>
        <span className="font-bold text-accent/70 uppercase tracking-wider">
          Tech
        </span>
        <span className="text-border-bright ml-1">
          {techInfo.sessionId}
        </span>
      </button>

      {isOpen && (
        <div className="px-4 py-3 bg-chat-bg text-[10px] space-y-3 animate-fade-in">
          <div>
            <h4 className="text-accent text-[10px] font-bold uppercase tracking-wider mb-1 m-0">
              Identity
            </h4>
            <CopyableRow label="My Key" value={techInfo.myPubKey} />
            <CopyableRow label="Peer Key" value={techInfo.peerPubKey} />
            <TechRow label="Enc Key" value={techInfo.encKeyPreview} mono />
          </div>
          <div>
            <h4 className="text-accent text-[10px] font-bold uppercase tracking-wider mb-1 m-0">
              Protocol
            </h4>
            <TechRow label="Network" value={techInfo.protocol} />
            <TechRow label="Encryption" value={techInfo.encryption} />
            <TechRow label="TTL" value={`${techInfo.messageTtl}s`} />
          </div>
          <div>
            <h4 className="text-accent text-[10px] font-bold uppercase tracking-wider mb-1 m-0">
              ACK
            </h4>
            <TechRow
              label="My ACK"
              value={
                techInfo.myAck > 0
                  ? `${techInfo.myAck} (${new Date(techInfo.myAck).toLocaleTimeString()})`
                  : "none"
              }
              mono
            />
            <TechRow
              label="Peer ACK"
              value={
                techInfo.peerAck > 0
                  ? `${techInfo.peerAck} (${new Date(techInfo.peerAck).toLocaleTimeString()})`
                  : "none"
              }
              mono
            />
            <TechRow label="Buffer" value={`${techInfo.sentBufferSize} pending`} />
          </div>
          <div>
            <h4 className="text-accent text-[10px] font-bold uppercase tracking-wider mb-1 m-0">
              Connection
            </h4>
            <TechRow label="Status" value={status} />
            <TechRow
              label="Poll"
              value={`${techInfo.currentPollInterval / 1000}s ${techInfo.currentPollInterval === 15_000 ? "(idle)" : "(active)"}`}
            />
            <TechRow label="Polls" value={techInfo.pollCount.toString()} />
            <TechRow
              label="Last Sync"
              value={lastSync ? new Date(lastSync).toLocaleTimeString() : "—"}
            />
            <TechRow label="Messages" value={messageCount.toString()} />
          </div>
        </div>
      )}
    </div>
  );
}
