import { useRef, useState } from "react";
import { usePlatformValue } from "../hooks/useServicesPlatform";
import { useStoredSessions } from "../hooks/useStoredSessions";
import { listShownSessions } from "../lib/storage";
import { sameValue } from "../lib/sameValue";
import { contactTag, publicKeyLabel } from "../lib/publicKeyLabel";
import { servicesPlatform, type SharedService } from "../lib/platform";
import { Block, Button, Notice, Row, Section, Switch, SwitchLook, input } from "../components/wallet/ui";
import { ButtonGroup, FieldGrid, Page } from "../components/layout";
import { externalLinkProps } from "../lib/externalLink";
import { useI18n } from "../contexts/I18nContext";
import { problemLine } from "../lib/problemText";
const GLOBE = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;

/**
 * The chats' keys and names, through the page's one cache of the stored chats: a chat's stored copy, messages and all,
 * is parsed only when it changed, not on every draw.
 */
const storedContacts = () => listShownSessions().map((s) => ({ key: s.peerPubKeyB64, label: s.label, nick: s.nick }));

/** Everyone this device has a chat with, by the key services are granted to. */
function useContacts() {
  const { t } = useI18n();
  return useStoredSessions(storedContacts, sameValue).map((s) => ({ key: s.key, name: s.label || s.nick || t("common.unnamedContact", { key: contactTag(s.key) }), short: publicKeyLabel(s.key) }));
}

/** What the page shows of the platform: drawn again when that changes, not on every engine state. */
const shown = () => servicesPlatform && {
  online: servicesPlatform.isOnline(),
  services: servicesPlatform.getSharedServices(),
  canShare: servicesPlatform.features.shareLocalServices,
};

/**
 * Services, as a page beside the chat list like Settings and the wallet: the local web apps this
 * device shares and exactly who can reach each one, and the apps contacts share back.
 */
export function Services() {
  const platform = servicesPlatform;
  const { t } = useI18n();
  const contacts = useContacts();
  const view = usePlatformValue(shown);
  // The apps each listed contact shares back.
  const theirApps = usePlatformValue(() => contacts.map((c) => (servicesPlatform?.getPeer(c.key)?.services ?? []).filter((s) => s.type === "http")));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""), [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [openError, setOpenError] = useState("");
  // Share waits on the host's permission (Chrome's prompt, Desktop's dialog): pressed again meanwhile, it added the app twice.
  const sharing = useRef(false);
  const [busy, setBusy] = useState(false);
  if (!platform || !view) return null;

  const { online, services, canShare } = view;
  const fromContacts = contacts
    .map((c, i) => ({ ...c, apps: theirApps[i] ?? [] }))
    .filter((c) => c.apps.length > 0);

  const share = async () => {
    if (sharing.current) return;
    sharing.current = true;
    setBusy(true);
    setError("");
    try { await platform.shareService(name, target); setName(""); setTarget(""); setAdding(false); }
    catch (e) { setError(problemLine(e, t)); }
    finally { sharing.current = false; setBusy(false); }
  };

  return (
    <Page title={t("tabs.services")} testId="my-services" trailing={
      // Ghostly's own network switch: off, every chat goes offline. Where nothing can be shared (the web) it says so,
      // with a name that stays put, rather than a state and a hint about shares.
      <button type="button" role="switch" aria-checked={online} data-testid="online-toggle" onClick={() => void platform.setOnline(!online)}
        title={!online ? t("services.goOnline") : canShare ? t("services.goOffline") : t("services.offDisconnectsChats")}
        className={`flex items-center gap-2 rounded-full px-3 min-h-9 text-sm border transition-colors cursor-pointer ${online ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-surface-alt text-text-muted"}`}>
        {canShare ? <span aria-hidden="true" className={`w-2 h-2 rounded-full ${online ? "bg-accent" : "bg-gray-500"}`} /> : <SwitchLook checked={online} className="scale-75 -mx-1.5" />}
        <span>{canShare ? (online ? t("services.online") : t("services.offline")) : t("services.ghostlyOnline")}</span>
      </button>
    }>
      <Section title={t("services.yourApps")} testId="your-apps">
        {services.length === 0 && !adding && <Block><Notice>{canShare ? t("services.nothingShared") : t("services.needsApp")}</Notice></Block>}
        {services.map((service) => <ServiceCard key={service.id} service={service} online={online} contacts={contacts} />)}
        {canShare && (adding ? (
          <Block>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void share(); }}>
              <FieldGrid>
                <input data-testid="service-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("services.namePlaceholder")} maxLength={48} className={input} />
                <input data-testid="service-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="localhost:3400" className={`${input} font-mono`} />
              </FieldGrid>
              <Notice>{t("services.nobodyYet")}</Notice>
              {error && <Notice tone="error">{error}</Notice>}
              <ButtonGroup>
                <Button type="submit" variant="primary" data-testid="service-save" disabled={!name.trim() || !target.trim()} loading={busy}>{t("services.share")}</Button>
                <Button onClick={() => { setAdding(false); setError(""); }}>{t("common.cancel")}</Button>
              </ButtonGroup>
            </form>
          </Block>
        ) : (
          <button data-testid="add-service" onClick={() => setAdding(true)} className="w-full flex items-center justify-center gap-2 px-4 py-3.5 text-sm text-text-secondary hover:text-accent hover:bg-surface-alt transition-colors cursor-pointer rounded-b-xl">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            {t("services.shareLocal")}
          </button>
        ))}
      </Section>

      <Section title={t("services.fromContacts")} testId="contact-services">
        {fromContacts.length === 0
          ? <Block><Notice>{t("services.fromContactsEmpty")}</Notice></Block>
          : fromContacts.map((contact) => (
            <Row key={contact.key} label={contact.name} hint={<span className="font-mono">{contact.short}</span>}>
              {contact.apps.map((app) => {
                const appName = app.name ?? app.id;
                // The verb around the name ("Open {{app}}", "{{app}} を開く") stays whole; the name alone is cut.
                const [before, after = ""] = t("services.open", { app: "\u0000" }).split("\u0000");
                return (
                  // At most the row's width, the name cut with an ellipsis in its own direction: a 46-character name went
                  // 51 px past a 375 px phone's edge, its start cut off in Arabic. The whole label is in the title.
                  <Button key={app.id} variant="primary" data-testid="contact-service-open" title={t("services.open", { app: appName })}
                    className="flex items-center max-w-full min-w-0" onClick={() => {
                      setOpenError("");
                      if (!platform.features.openServices) { setOpenError(t("services.openNeedsApp")); return; }
                      platform.openService(contact.key, app.id).catch((e) => setOpenError(problemLine(e, t)));
                    }}>
                    {before && <span className="whitespace-pre">{before}</span>}
                    <span data-testid="contact-service-name" className="truncate" dir="auto">{appName}</span>
                    {after && <span className="whitespace-pre">{after}</span>}
                  </Button>
                );
              })}
            </Row>
          ))}
        {openError && <Block><Notice tone="error">{openError}</Notice></Block>}
      </Section>
    </Page>
  );
}

function ServiceCard({ service, online, contacts }: { service: SharedService; online: boolean; contacts: { key: string; name: string; short: string }[] }) {
  const platform = servicesPlatform!;
  const { t } = useI18n();
  const [showPeople, setShowPeople] = useState(false);
  const granted = service.sharedWith ?? [];
  const reached = granted.length;
  const shared = service.enabled && online && reached > 0;
  const status = shared ? (reached === 1 ? t("services.status.sharedOne") : t("services.status.sharedCount", { count: reached }))
    : !service.enabled ? t("services.status.stopped")
    : reached === 0 ? t("services.status.notShared")
    : t("services.status.offline");
  const href = /^https?:\/\//.test(service.target) ? service.target : `http://${service.target}`;
  return (
    <div data-testid="service-item">
      <Row leading={<span className={`grid place-items-center w-10 h-10 rounded-xl ${shared ? "bg-accent/15 text-accent" : "bg-surface-alt text-text-muted"}`}>{GLOBE}</span>}
        label={<>
          {/* Each in its own direction, on the box that cuts it and as wide as its words, as a contact's app below: in
              Arabic a Latin name or address keeps its start, and a short one stays at the line's start. */}
          <p className="font-medium"><span dir="auto" className="inline-block max-w-full truncate align-top">{service.name}</span></p>
          <a {...externalLinkProps(href)} title={service.target} dir="auto" className="inline-block max-w-full align-top text-xs font-mono text-text-muted hover:text-accent truncate">{service.target.replace(/^https?:\/\//, "")}</a>
        </>}
        hint={<span className={`flex flex-wrap items-center gap-x-1.5 mt-0.5 ${shared ? "text-accent" : "text-text-muted"}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${shared ? "bg-accent" : "bg-gray-500"}`} />{status}
          {service.requests > 0 && <span className="text-text-muted">{t("services.requestCount", { count: service.requests })}</span>}
        </span>}>
          <Button onClick={() => setShowPeople(!showPeople)} data-testid="service-people" aria-expanded={showPeople}>{showPeople ? t("services.peopleDone") : t("services.people")}</Button>
          <Switch label={t("services.shareNamed", { app: service.name })} testId="service-sharing" checked={service.enabled} onChange={(on) => void platform.setServiceEnabled(service.id, on)} />
          <button type="button" aria-label={t("services.removeNamed", { app: service.name })} title={t("services.remove")} onClick={() => void platform.removeService(service.id)} className="grid place-items-center w-10 h-10 rounded-lg text-text-muted hover:text-danger hover:bg-surface-alt transition-colors cursor-pointer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
          </button>
      </Row>
      {showPeople && (
        <div className="mx-4 mb-4 rounded-xl bg-surface-alt divide-y divide-border" data-testid="service-grants">
          {contacts.length === 0 && <p className="px-4 py-3 text-xs text-text-muted">{t("services.noContacts")}</p>}
          {contacts.map((c) => {
            const on = granted.includes(c.key);
            return (
              <div key={c.key} className="flex items-center gap-3 px-4 py-2.5 min-h-12" data-testid="service-grant">
                <div className="min-w-0 flex-1 flex flex-col items-start"><p dir="auto" className="max-w-full text-sm text-text-primary truncate">{c.name}</p><p dir="auto" className="max-w-full text-[11px] text-text-muted font-mono truncate">{c.short}</p></div>
                <Switch label={t("services.letReach", { contact: c.name, app: service.name })} checked={on} onChange={(next) => void platform.setServiceShared(service.id, c.key, next)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
