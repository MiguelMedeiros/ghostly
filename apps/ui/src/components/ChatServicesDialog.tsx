import { useRef } from "react";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { Switch } from "./wallet/ui";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { servicesUnavailable } from "../lib/servicesAvailability";
import { useI18n } from "../contexts/I18nContext";

const GLOBE = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;

/**
 * Which of your web apps this one contact can reach, chosen in the chat itself, and the apps the
 * contact lets you open. Apps are added on the Services page; granting happens per contact.
 */
export function ChatServicesDialog({ peerPubKey, name, onClose }: { peerPubKey: string; name: string; onClose: () => void }) {
  const platform = useServicesPlatform();
  const nav = useAppNavigation();
  const { t } = useI18n();
  const backdrop = useBackdropDismiss(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  if (!platform) return null;
  const online = platform.isOnline();
  const mine = platform.features.shareLocalServices ? platform.getSharedServices() : [];
  const peer = platform.getPeer(peerPubKey);
  const theirs = (peer?.services ?? []).filter((s) => s.type === "http");
  const unavailable = servicesUnavailable(peer, name, t);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chat-services-title" data-testid="chat-services" className="focus:outline-none w-full max-w-md bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4 max-h-[85dvh] overflow-y-auto">
        <div>
          <h2 id="chat-services-title" className="text-lg font-medium text-text-primary">{t("chat.services.title", { name })}</h2>
          <p className="text-xs text-text-muted mt-1">{t("chat.services.pick", { name })}</p>
          {unavailable && <p data-testid="chat-services-unavailable" className="text-xs text-text-secondary mt-2">{unavailable}</p>}
        </div>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-accent uppercase tracking-wide">{t("chat.services.yours")}</h3>
          <div className="bg-surface rounded-xl divide-y divide-border">
            {!platform.features.shareLocalServices ? (
              <p className="px-4 py-3 text-xs text-text-muted">{t("chat.services.needsApp")}</p>
            ) : mine.length === 0 ? (
              <p className="px-4 py-3 text-xs text-text-muted">{t("chat.services.none")}</p>
            ) : mine.map((service) => {
              const on = service.sharedWith?.includes(peerPubKey) ?? false;
              const note = !service.enabled ? t("chat.services.paused") : !online ? t("connection.state.offline") : on ? t("chat.services.shared") : t("chat.services.notShared");
              return (
                <div key={service.id} className="flex items-center gap-3 px-4 py-3" data-testid="chat-service-grant">
                  <span className={`shrink-0 grid place-items-center w-9 h-9 rounded-lg ${on && service.enabled ? "bg-accent/15 text-accent" : "bg-surface-alt text-text-muted"}`}>{GLOBE}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-primary truncate">{service.name}</p>
                    <p className="text-[11px] text-text-muted font-mono truncate">{service.target.replace(/^https?:\/\//, "")}</p>
                    <p className="text-[11px] text-text-secondary">{note}</p>
                  </div>
                  <Switch label={t("chat.services.let", { name, service: service.name })} testId="chat-service-toggle" checked={on} onChange={(next) => void platform.setServiceShared(service.id, peerPubKey, next)} />
                </div>
              );
            })}
            {platform.features.shareLocalServices && (
              <button type="button" onClick={() => { onClose(); nav.open("/services"); }} className="w-full px-4 py-3 text-sm text-text-secondary hover:text-accent hover:bg-surface-alt text-start cursor-pointer rounded-b-xl">
                {t("chat.services.add")}
              </button>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-accent uppercase tracking-wide">{t("chat.services.from", { name })}</h3>
          <div className="bg-surface rounded-xl divide-y divide-border">
            {theirs.length === 0 ? <p className="px-4 py-3 text-xs text-text-muted">{t("chat.services.nothing")}</p>
              : theirs.map((service) => (
                <div key={service.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="shrink-0 grid place-items-center w-9 h-9 rounded-lg bg-accent/15 text-accent">{GLOBE}</span>
                  <p className="flex-1 text-sm text-text-primary truncate">{service.name ?? service.id}</p>
                  {platform.features.openServices
                    ? <button type="button" data-testid="chat-service-open" onClick={() => void platform.openService(peerPubKey, service.id).catch(() => {})}
                      className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer">{t("chat.services.open")}</button>
                    : <span className="text-[11px] text-text-muted text-end">{t("chat.services.openElsewhere")}</span>}
                </div>
              ))}
          </div>
        </section>

        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-surface-alt text-text-primary border border-border hover:bg-surface-hover cursor-pointer">{t("chat.services.done")}</button>
        </div>
      </div>
    </div>
  );
}
