import { useState } from "react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

/**
 * Sidebar section: whether this peer is online, and the local web apps it
 * shares. Nothing is reachable unless it is listed here.
 */
export function MyServices() {
  const platform = useServicesPlatform();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  if (!platform) return null;

  const online = platform.isOnline();
  const services = platform.getSharedServices();

  const share = async () => {
    setError("");
    try {
      await platform.shareService(name, target);
      setName("");
      setTarget("");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="border-t border-border bg-sidebar-bg" data-testid="my-services">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-text-secondary text-xs font-bold uppercase tracking-wider">Services</span>
        <button
          data-testid="online-toggle"
          onClick={() => void platform.setOnline(!online)}
          className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text-primary transition-colors cursor-pointer"
          title={online ? "Go offline: nothing you share stays reachable" : "Go online"}
        >
          <span className={`w-2 h-2 rounded-full ${online ? "bg-accent" : "bg-gray-500"}`} />
          {online ? "Online" : "Offline"}
        </button>
      </div>

      <div className="px-3 pb-3 space-y-2">
        {services.map((service) => {
          const shared = service.enabled && online;
          return (
            <div key={service.id} data-testid="service-item" className="bg-surface-alt rounded-lg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-text-primary text-sm truncate">{service.name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => void platform.setServiceEnabled(service.id, !service.enabled)}
                    className="px-2 py-0.5 text-[11px] font-bold text-text-secondary bg-surface-hover rounded hover:text-text-primary transition-colors cursor-pointer"
                  >
                    {service.enabled ? "Stop" : "Share"}
                  </button>
                  <button
                    onClick={() => void platform.removeService(service.id)}
                    className="px-1.5 py-0.5 text-text-muted hover:text-danger transition-colors cursor-pointer text-base leading-none"
                    title="Remove"
                  >
                    &times;
                  </button>
                </div>
              </div>
              <p className="text-text-muted text-[11px] font-mono truncate">{service.target.replace(/^https?:\/\//, "")}</p>
              <p className={`flex items-center gap-1.5 text-[11px] mt-1 ${shared ? "text-accent" : "text-text-muted"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${shared ? "bg-accent" : "bg-gray-500"}`} />
                {shared ? "Shared with your contacts" : service.enabled ? "Not reachable while offline" : "Stopped"}
                {service.requests > 0 && <span className="text-text-muted ml-auto">{service.requests} requests</span>}
              </p>
            </div>
          );
        })}

        {adding ? (
          <form
            className="bg-surface-alt rounded-lg p-3 space-y-2 animate-fade-in"
            onSubmit={(e) => {
              e.preventDefault();
              void share();
            }}
          >
            <input
              data-testid="service-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (Atlas)"
              maxLength={48}
              className="w-full bg-input-bg rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <input
              data-testid="service-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="localhost:3400"
              className="w-full bg-input-bg rounded-lg px-3 py-2 text-sm font-mono text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p className="text-text-muted text-[11px] leading-snug">
              Your contacts will be able to use this app as if they were on this machine, while you are online. Only
              this address is exposed.
            </p>
            {error && <p className="text-danger text-xs">{error}</p>}
            <div className="flex gap-2">
              <button
                data-testid="service-save"
                disabled={!name.trim() || !target.trim()}
                className="flex-1 px-3 py-2 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Share
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setError("");
                }}
                className="px-3 py-2 text-xs font-bold text-text-muted bg-surface-hover rounded-lg hover:text-text-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            data-testid="add-service"
            onClick={() => setAdding(true)}
            className="w-full flex items-center justify-center gap-2 py-2 text-text-muted hover:text-accent hover:bg-surface-alt rounded-lg transition-colors cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="text-xs font-medium">Share a local service</span>
          </button>
        )}
      </div>
    </div>
  );
}
