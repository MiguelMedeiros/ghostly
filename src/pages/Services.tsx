import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { listSessions } from "../lib/storage";
import { publicKeyLabel } from "../lib/publicKeyLabel";
import type { SharedService } from "../lib/platform";
import { Block, Button, Notice, Row, Section, Switch, input } from "../components/wallet/ui";

const GLOBE = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;

/** Everyone this device has a chat with, by the key services are granted to. */
function useContacts() {
  return listSessions().map((s) => ({ key: s.peerPubKeyB64, name: s.label || s.nick || "Anonymous", short: publicKeyLabel(s.peerPubKeyB64) }));
}

/**
 * Services, as a page beside the chat list like Settings and the wallet: the local web apps this
 * device shares and exactly who can reach each one, and the apps contacts share back.
 */
export function Services() {
  const navigate = useNavigate();
  const platform = useServicesPlatform();
  const contacts = useContacts();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""), [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [openError, setOpenError] = useState("");
  if (!platform) return null;

  const online = platform.isOnline();
  const services = platform.getSharedServices();
  const canShare = platform.features.shareLocalServices;
  const fromContacts = contacts
    .map((c) => ({ ...c, apps: (platform.getPeer(c.key)?.services ?? []).filter((s) => s.type === "http") }))
    .filter((c) => c.apps.length > 0);

  const share = async () => {
    setError("");
    try { await platform.shareService(name, target); setName(""); setTarget(""); setAdding(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="flex-1 flex flex-col bg-chat-bg overflow-hidden min-h-0" data-testid="my-services">
      <header className="h-14 header-safe shrink-0 bg-panel-header flex items-center px-4 border-b border-border gap-3">
        <button onClick={() => navigate(-1)} className="max-md:hidden p-2 hover:bg-surface-hover rounded-full transition-colors cursor-pointer" aria-label="Back">
          <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h1 className="flex-1 text-lg font-medium text-text-primary">Services</h1>
        <button data-testid="online-toggle" onClick={() => void platform.setOnline(!online)} title={online ? "Go offline: nothing you share stays reachable" : "Go online"}
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm border transition-colors cursor-pointer ${online ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-surface-alt text-text-muted"}`}>
          <span aria-hidden="true" className={`w-2 h-2 rounded-full ${online ? "bg-accent" : "bg-gray-500"}`} />
          <span>{online ? "Online" : "Offline"}</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6 max-md:p-4">
        <div className="max-w-3xl mx-auto space-y-8">
          <Section title="Your apps" testId="your-apps">
            {services.length === 0 && !adding && <Block><Notice>{canShare ? "Nothing shared yet." : "Sharing a local web app needs the Ghostly browser extension or desktop app."}</Notice></Block>}
            {services.map((service) => <ServiceCard key={service.id} service={service} online={online} contacts={contacts} />)}
            {canShare && (adding ? (
              <Block>
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void share(); }}>
                  <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
                    <input data-testid="service-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (Atlas)" maxLength={48} className={input} />
                    <input data-testid="service-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="localhost:3400" className={`${input} font-mono`} />
                  </div>
                  <Notice>Nobody can open it until you pick who.</Notice>
                  {error && <Notice tone="error">{error}</Notice>}
                  <div className="flex gap-2">
                    <Button type="submit" variant="primary" data-testid="service-save" disabled={!name.trim() || !target.trim()}>Share</Button>
                    <Button onClick={() => { setAdding(false); setError(""); }}>Cancel</Button>
                  </div>
                </form>
              </Block>
            ) : (
              <button data-testid="add-service" onClick={() => setAdding(true)} className="w-full flex items-center justify-center gap-2 px-4 py-3.5 text-sm text-text-secondary hover:text-accent hover:bg-surface-alt transition-colors cursor-pointer rounded-b-xl">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                Share a local service
              </button>
            ))}
          </Section>

          <Section title="From your contacts" testId="contact-services">
            {fromContacts.length === 0
              ? <Block><Notice>Apps your contacts share show up here.</Notice></Block>
              : fromContacts.map((contact) => (
                <Row key={contact.key} label={contact.name} hint={contact.short}>
                  {contact.apps.map((app) => (
                    <Button key={app.id} variant="primary" data-testid="contact-service-open" onClick={() => {
                      setOpenError("");
                      if (!platform.features.openServices) { setOpenError("Opening a contact's web app needs the Ghostly browser extension or desktop app."); return; }
                      platform.openService(contact.key, app.id).catch((e) => setOpenError(e instanceof Error ? e.message : String(e)));
                    }}>Open {app.name ?? app.id}</Button>
                  ))}
                </Row>
              ))}
            {openError && <Block><Notice tone="error">{openError}</Notice></Block>}
          </Section>
        </div>
      </div>
    </div>
  );
}

function ServiceCard({ service, online, contacts }: { service: SharedService; online: boolean; contacts: { key: string; name: string; short: string }[] }) {
  const platform = useServicesPlatform()!;
  const [showPeople, setShowPeople] = useState(false);
  const granted = service.sharedWith ?? [];
  const reached = granted.length;
  const shared = service.enabled && online && reached > 0;
  const status = shared ? `Shared with ${reached} ${reached === 1 ? "contact" : "contacts"}`
    : !service.enabled ? "Stopped"
    : reached === 0 ? "Not shared with anyone yet"
    : "Not reachable while offline";
  const href = /^https?:\/\//.test(service.target) ? service.target : `http://${service.target}`;
  return (
    <div data-testid="service-item">
      <div className="flex items-center gap-3 px-4 py-3.5 max-sm:flex-wrap">
        <span className={`shrink-0 grid place-items-center w-10 h-10 rounded-xl ${shared ? "bg-accent/15 text-accent" : "bg-surface-alt text-text-muted"}`}>{GLOBE}</span>
        <div className="min-w-0 flex-1">
          <p className="text-text-primary text-sm font-medium truncate">{service.name}</p>
          <a href={href} target="_blank" rel="noreferrer" className="block text-xs font-mono text-text-muted hover:text-accent truncate">{service.target.replace(/^https?:\/\//, "")}</a>
          <p className={`flex items-center gap-1.5 text-xs mt-1 ${shared ? "text-accent" : "text-text-muted"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${shared ? "bg-accent" : "bg-gray-500"}`} />{status}
            {service.requests > 0 && <span className="text-text-muted ml-2">· {service.requests} requests</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 max-sm:w-full max-sm:justify-end">
          <Button onClick={() => setShowPeople(!showPeople)} data-testid="service-people" aria-expanded={showPeople}>{showPeople ? "Done" : "People"}</Button>
          <Switch label={`Share ${service.name}`} testId="service-sharing" checked={service.enabled} onChange={(on) => void platform.setServiceEnabled(service.id, on)} />
          <button type="button" aria-label={`Remove ${service.name}`} title="Remove" onClick={() => void platform.removeService(service.id)} className="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-surface-alt transition-colors cursor-pointer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
          </button>
        </div>
      </div>
      {showPeople && (
        <div className="mx-4 mb-4 rounded-xl bg-surface-alt divide-y divide-border" data-testid="service-grants">
          {contacts.length === 0 && <p className="px-4 py-3 text-xs text-text-muted">No contacts yet.</p>}
          {contacts.map((c) => {
            const on = granted.includes(c.key);
            return (
              <div key={c.key} className="flex items-center gap-3 px-4 py-2.5" data-testid="service-grant">
                <div className="min-w-0 flex-1"><p className="text-sm text-text-primary truncate">{c.name}</p><p className="text-[11px] text-text-muted font-mono">{c.short}</p></div>
                <Switch label={`Let ${c.name} reach ${service.name}`} checked={on} onChange={(next) => void platform.setServiceShared(service.id, c.key, next)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
