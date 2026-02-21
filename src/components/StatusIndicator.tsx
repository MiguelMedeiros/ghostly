import type { ConnectionStatus } from "../lib/types";

interface StatusIndicatorProps {
  status: ConnectionStatus;
  lastSync: number | null;
}

export function StatusIndicator({ status, lastSync }: StatusIndicatorProps) {
  const statusConfig = {
    connecting: { color: "bg-yellow-500", label: "Connecting" },
    online: { color: "bg-emerald-500", label: "Online" },
    offline: { color: "bg-gray-500", label: "Offline" },
    error: { color: "bg-danger", label: "Error" },
  };

  const { color, label } = statusConfig[status];

  const syncText = lastSync
    ? `Last sync: ${new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "Not synced yet";

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-surface-alt border-b border-border text-[11px] text-text-muted">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${color} animate-pulse-dot`} />
        <span>{label}</span>
      </div>
      <span className="text-border-bright">|</span>
      <span>{syncText}</span>
    </div>
  );
}
