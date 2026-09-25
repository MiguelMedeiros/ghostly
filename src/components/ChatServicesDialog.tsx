import { useRef } from "react";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { Switch } from "./wallet/ui";
import { useAppNavigation } from "../hooks/useAppNavigation";

const GLOBE = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;

/**
 * Which of your web apps this one contact can reach, chosen in the chat itself, and the apps the
 * contact lets you open. Apps are added on the Services page; granting happens per contact.
 */
export function ChatServicesDialog({ peerPubKey, name, onClose }: { peerPubKey: string; name: string; onClose: () => void }) {
  const platform = useServicesPlatform();
  const nav = useAppNavigation();
  const backdrop = useBackdropDismiss(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  if (!platform) return null;
  const online = platform.isOnline();
  const mine = platform.features.shareLocalServices ? platform.getSharedServices() : [];
  const theirs = (platform.getPeer(peerPubKey)?.services ?? []).filter((s) => s.type === "http");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chat-services-title" data-testid="chat-services" className="focus:outline-none w-full max-w-md bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4 max-h-[85dvh] overflow-y-auto">
        <div>
          <h2 id="chat-services-title" className="text-lg font-medium text-text-primary">Apps with {name}</h2>
          <p className="text-xs text-text-muted mt-1">Pick which of your apps {name} can open.</p>
        </div>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-accent uppercase tracking-wide">Your apps</h3>
          <div className="bg-surface rounded-xl divide-y divide-border">
            {!platform.features.shareLocalServices ? (
              <p className="px-4 py-3 text-xs text-text-muted">Needs the extension or desktop app.</p>
            ) : mine.length === 0 ? (
              <p className="px-4 py-3 text-xs text-text-muted">No apps yet.</p>
            ) : mine.map((service) => {
              const on = service.sharedWith?.includes(peerPubKey) ?? false;
              const note = !service.enabled ? "Paused" : !online ? "Offline" : on ? "Shared" : "Not shared";
              return (
                <div key={service.id} className="flex items-center gap-3 px-4 py-3" data-testid="chat-service-grant">
                  <span className={`shrink-0 grid place-items-center w-9 h-9 rounded-lg ${on && service.enabled ? "bg-accent/15 text-accent" : "bg-surface-alt text-text-muted"}`}>{GLOBE}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-primary truncate">{service.name}</p>
                    <p className="text-[11px] text-text-muted font-mono truncate">{service.target.replace(/^https?:\/\//, "")}</p>
                    <p className="text-[11px] text-text-secondary">{note}</p>
                  </div>
                  <Switch label={`Let ${name} open ${service.name}`} testId="chat-service-toggle" checked={on} onChange={(next) => void platform.setServiceShared(service.id, peerPubKey, next)} />
                </div>
              );
            })}
            {platform.features.shareLocalServices && (
              <button type="button" onClick={() => { onClose(); nav.open("/services"); }} className="w-full px-4 py-3 text-sm text-text-secondary hover:text-accent hover:bg-surface-alt text-left cursor-pointer rounded-b-xl">
                + Add an app
              </button>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-accent uppercase tracking-wide">From {name}</h3>
          <div className="bg-surface rounded-xl divide-y divide-border">
            {theirs.length === 0 ? <p className="px-4 py-3 text-xs text-text-muted">Nothing shared with you.</p>
              : theirs.map((service) => (
                <div key={service.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="shrink-0 grid place-items-center w-9 h-9 rounded-lg bg-accent/15 text-accent">{GLOBE}</span>
                  <p className="flex-1 text-sm text-text-primary truncate">{service.name ?? service.id}</p>
                  {platform.features.openServices
                    ? <button type="button" data-testid="chat-service-open" onClick={() => void platform.openService(peerPubKey, service.id).catch(() => {})}
                      className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-[#111b21] hover:bg-accent-hover cursor-pointer">Open</button>
                    : <span className="text-[11px] text-text-muted text-right">Open it from the extension or desktop app</span>}
                </div>
              ))}
          </div>
        </section>

        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-surface-alt text-text-primary border border-border hover:bg-surface-hover cursor-pointer">Done</button>
        </div>
      </div>
    </div>
  );
}
