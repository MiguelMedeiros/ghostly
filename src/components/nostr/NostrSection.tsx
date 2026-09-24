import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { NostrDraftRequest, NostrOwnView } from "@ghostly/browser/nostr/types";
import { useEngineState } from "../../lib/identities";
import { ago } from "../../lib/nostr";
import { Block, Button, Notice, Row, Section, Switch, input } from "../wallet/ui";
import { FieldGrid, InputGroup } from "../layout";
import { NostrPublishDialog } from "./NostrPublishDialog";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Identities → Nostr: the relays this app asks (shown, so the person knows who learns what), the two
 * optional capabilities (automatic profiles, publication), and for each Nostr key the person proved, their
 * own profile, follows and mute list, with the actions publication allows: post a note, update the profile.
 */
export function NostrSection() {
  const state = useEngineState();
  const settings = state?.nostr.settings;
  const own = state?.nostr.own ?? [];
  const [relays, setRelays] = useState("");
  const [error, setError] = useState("");
  const [publish, setPublish] = useState<NostrDraftRequest | null>(null);
  useEffect(() => { if (settings) setRelays(settings.relays.join("\n")); }, [settings]);
  if (!state || !settings) return null;
  const save = (patch: Partial<typeof settings>) => { setError(""); return engine.call("updateSettings", { settings: { nostr: { ...settings, ...patch } } }).catch(e => setError(message(e))); };
  const relaysChanged = relays.split(/\s+/).filter(Boolean).join("\n") !== settings.relays.join("\n");

  return (<>
    <Section title="Nostr" testId="nostr-section">
      <Block>
        <div>
          <label htmlFor="nostr-relays" className="text-text-primary text-sm block">Relays</label>
          <p className="text-text-muted text-xs mt-0.5">Asked for contacts' profiles, follows and notes, and sent what you publish. Each one learns your IP address and which keys you look up. Nothing is asked until you load something.</p>
        </div>
        <InputGroup as="form" onSubmit={e => { e.preventDefault(); void save({ relays: relays.split(/\s+/).filter(Boolean) }); }}>
          <textarea id="nostr-relays" data-testid="nostr-relays" value={relays} onChange={e => setRelays(e.target.value)} rows={2} spellCheck={false} className={`${input} font-mono text-xs`} placeholder="wss://…" />
          <Button type="submit" data-testid="nostr-relays-save" disabled={!relaysChanged}>Save</Button>
        </InputGroup>
      </Block>
      <Row label="Load contacts' profiles automatically" hint="When a contact's Nostr proof is verified, and again when it is a day old. Off: only when you press Load profile.">
        <Switch testId="nostr-auto-load" label="Load contacts' profiles automatically" checked={settings.autoLoadProfiles} onChange={v => void save({ autoLoadProfiles: v })} />
      </Row>
      <Row label="Publish on Nostr" hint="Post notes, follow and unfollow, update your profile, through your own signer. Every action is shown and confirmed first; everything published is public.">
        <Switch testId="nostr-publish" label="Publish on Nostr" checked={settings.publish} onChange={v => void save({ publish: v })} />
      </Row>
      {own.length === 0 && <Block><p className="text-xs text-text-muted">Add a Nostr identity under Identities to see your own profile and follows here.</p></Block>}
      {own.map(o => <OwnKey key={o.subject} view={o} publish={settings.publish} onPublish={setPublish} onError={setError} />)}
      {error && <Block><Notice tone="error" testId="nostr-section-error">{error}</Notice></Block>}
    </Section>
    {publish && <NostrPublishDialog request={publish} onClose={() => setPublish(null)} />}
  </>);
}

function OwnKey({ view, publish, onPublish, onError }: { view: NostrOwnView; publish: boolean; onPublish: (r: NostrDraftRequest) => void; onError: (e: string) => void }) {
  const [mode, setMode] = useState<"" | "note" | "profile">("");
  const [note, setNote] = useState("");
  const p = view.profile?.profile;
  const [fields, setFields] = useState({ displayName: "", name: "", about: "", picture: "", nip05: "", website: "" });
  const load = () => { onError(""); void engine.call("nostrLoadOwn", { subject: view.subject }).catch(e => onError(message(e))); };
  const startProfile = () => { setFields({ displayName: p?.name ?? "", name: p?.handle ?? p?.name ?? "", about: p?.about ?? "", picture: "", nip05: p?.nip05 ?? "", website: p?.website ?? "" }); setMode("profile"); };
  const short = `${view.npub.slice(0, 12)}…${view.npub.slice(-4)}`;
  return (
    <Block testId="nostr-own">
      <div className="flex items-start gap-3">
        {p?.avatar ? <img src={p.avatar} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" /> : null}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-primary break-words" data-testid="nostr-own-name">{p?.name ?? (view.profile ? "No profile published" : "Your Nostr key")}</p>
          <p className="text-xs text-text-muted font-mono break-all" title={view.npub}>{short}</p>
          {view.profile && <p className="text-[11px] text-text-muted">Profile {view.profile.stale ? "stale, " : ""}from {view.profile.relays.map(r => r.replace(/^wss?:\/\//, "")).join(", ")} {ago(view.profile.fetchedAt)}.</p>}
          {view.follows && <p className="text-xs text-text-muted" data-testid="nostr-own-follows">You follow {view.follows.follows.length} {view.follows.follows.length === 1 ? "account" : "accounts"}{view.follows.eventAt ? ` (list as of ${ago(view.follows.eventAt)})` : ""}.</p>}
          {view.mute && <p className="text-xs text-text-muted" data-testid="nostr-own-mute">Mute list: {view.mute.pubkeys} {view.mute.pubkeys === 1 ? "key" : "keys"}, {view.mute.words} {view.mute.words === 1 ? "word" : "words"}, {view.mute.notes} {view.mute.notes === 1 ? "note" : "notes"}{view.mute.hasPrivate ? "; its private part is not read" : ""}. Applied to contacts' notes here.</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button data-testid="nostr-own-load" disabled={view.loading} onClick={load}>{view.loading ? "Loading…" : view.profile ? "Refresh" : "Load my profile and follows"}</Button>
        {publish && <Button data-testid="nostr-post" onClick={() => setMode(mode === "note" ? "" : "note")}>Post a note</Button>}
        {publish && <Button data-testid="nostr-profile-edit" onClick={() => mode === "profile" ? setMode("") : startProfile()}>Update profile</Button>}
      </div>
      {mode === "note" && (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); onPublish({ subject: view.subject, action: "note", content: note }); setMode(""); setNote(""); }}>
          <textarea data-testid="nostr-post-text" value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={4000} placeholder="What is on your mind? This will be public." className={input} />
          <div className="flex justify-end"><Button type="submit" variant="primary" data-testid="nostr-post-submit" disabled={!note.trim()}>Review and publish</Button></div>
        </form>
      )}
      {mode === "profile" && (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); onPublish({ subject: view.subject, action: "profile", fields: { displayName: fields.displayName, name: fields.name, about: fields.about, nip05: fields.nip05, website: fields.website, ...(fields.picture ? { picture: fields.picture } : {}) } }); setMode(""); }}>
          {!view.profile && <Notice>Load your profile first so fields you do not edit here are kept as they are.</Notice>}
          <FieldGrid>
            <input data-testid="nostr-profile-name" aria-label="Name" placeholder="Name" maxLength={64} value={fields.displayName} onChange={e => setFields({ ...fields, displayName: e.target.value })} className={input} />
            <input data-testid="nostr-profile-handle" aria-label="Handle" placeholder="Handle" maxLength={64} value={fields.name} onChange={e => setFields({ ...fields, name: e.target.value })} className={input} />
            <input data-testid="nostr-profile-nip05" aria-label="NIP-05 address" placeholder="name@domain (NIP-05)" maxLength={253} value={fields.nip05} onChange={e => setFields({ ...fields, nip05: e.target.value })} className={input} />
            <input data-testid="nostr-profile-website" aria-label="Website" placeholder="https://…" maxLength={512} value={fields.website} onChange={e => setFields({ ...fields, website: e.target.value })} className={input} />
            <input data-testid="nostr-profile-picture" aria-label="Picture address" placeholder="Picture https://… (unchanged if empty)" maxLength={2048} value={fields.picture} onChange={e => setFields({ ...fields, picture: e.target.value })} className={input} />
          </FieldGrid>
          <textarea data-testid="nostr-profile-about" aria-label="About" placeholder="About" rows={2} maxLength={500} value={fields.about} onChange={e => setFields({ ...fields, about: e.target.value })} className={input} />
          <p className="text-[11px] text-text-muted">An emptied field is removed from your profile; fields Ghostly does not show (a Lightning address, a banner) stay as they are.</p>
          <div className="flex justify-end"><Button type="submit" variant="primary" data-testid="nostr-profile-submit">Review and publish</Button></div>
        </form>
      )}
      {view.error && <Notice tone="error" testId="nostr-own-error">{view.error}</Notice>}
    </Block>
  );
}
