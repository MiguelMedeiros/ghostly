import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { NostrDraftRequest, NostrOwnView } from "@ghostly/browser/nostr/types";
import { useEngineState } from "../../lib/identities";
import { agoIn } from "../../lib/relativeTime";
import { useI18n } from "../../contexts/I18nContext";
import { Block, Button, Notice, Row, Section, Switch, input } from "../wallet/ui";
import { FieldGrid, InputGroup } from "../layout";
import { NostrPublishDialog } from "./NostrPublishDialog";
import { problemLine } from "../../lib/problemText";


/**
 * Identities → Nostr: the relays this app asks (shown, so the person knows who learns what), the two
 * optional capabilities (automatic profiles, publication), and for each Nostr key the person proved, their
 * own profile, follows and mute list, with the actions publication allows: post a note, update the profile.
 */
export function NostrSection() {
  const { t } = useI18n();
  const state = useEngineState();
  const settings = state?.nostr.settings;
  const own = state?.nostr.own ?? [];
  // What the person typed, kept until their save is in the engine's state: every state push carries a new
  // `settings`, and resetting the field from it would drop the edit (and turn Save off under the pointer).
  const [draft, setDraft] = useState<string | null>(null);
  const savedAfter = useRef<typeof state>(null);
  const [error, setError] = useState("");
  const [publish, setPublish] = useState<NostrDraftRequest | null>(null);
  // A state that reached this page after the save answered was made after the save: the list in it is the one kept.
  useEffect(() => { if (savedAfter.current && state !== savedAfter.current) { savedAfter.current = null; setDraft(null); } }, [state]);
  if (!state || !settings) return null;
  // Only the field that changes: the rest of the settings is the engine's, not this render's copy of it.
  const save = (patch: Partial<typeof settings>) => { setError(""); return engine.call("updateSettings", { settings: { nostr: patch } }); };
  const relays = draft ?? settings.relays.join("\n");
  const relaysChanged = relays.split(/\s+/).filter(Boolean).join("\n") !== settings.relays.join("\n");
  const saveRelays = () => save({ relays: relays.split(/\s+/).filter(Boolean) }).then(() => { savedAfter.current = engine.state; }, e => setError(problemLine(e, t)));
  const toggle = (patch: Partial<typeof settings>) => void save(patch).catch(e => setError(problemLine(e, t)));

  return (<>
    <Section title="Nostr" testId="nostr-section">
      <Block>
        <div>
          <label htmlFor="nostr-relays" className="text-text-primary text-sm block">{t("identities.nostr.relays")}</label>
          <p className="text-text-muted text-xs mt-0.5">{t("identities.nostr.relaysHint")}</p>
        </div>
        <InputGroup as="form" onSubmit={e => { e.preventDefault(); void saveRelays(); }}>
          <textarea id="nostr-relays" data-testid="nostr-relays" value={relays} onChange={e => setDraft(e.target.value)} rows={2} spellCheck={false} className={`${input} font-mono text-xs`} placeholder="wss://…" />
          <Button type="submit" data-testid="nostr-relays-save" disabled={!relaysChanged}>{t("common.save")}</Button>
        </InputGroup>
      </Block>
      <Row label={t("identities.nostr.autoLoad")} hint={t("identities.nostr.autoLoadHint")}>
        <Switch testId="nostr-auto-load" label={t("identities.nostr.autoLoad")} checked={settings.autoLoadProfiles} onChange={v => toggle({ autoLoadProfiles: v })} />
      </Row>
      <Row label={t("identities.nostr.publish")} hint={t("identities.nostr.publishHint")}>
        <Switch testId="nostr-publish" label={t("identities.nostr.publish")} checked={settings.publish} onChange={v => toggle({ publish: v })} />
      </Row>
      {own.length === 0 && <Block><p className="text-xs text-text-muted">{t("identities.nostr.addOwn")}</p></Block>}
      {own.map(o => <OwnKey key={o.subject} view={o} publish={settings.publish} onPublish={setPublish} onError={setError} />)}
      {error && <Block><Notice tone="error" testId="nostr-section-error">{error}</Notice></Block>}
    </Section>
    {publish && <NostrPublishDialog request={publish} onClose={() => setPublish(null)} />}
  </>);
}

function OwnKey({ view, publish, onPublish, onError }: { view: NostrOwnView; publish: boolean; onPublish: (r: NostrDraftRequest) => void; onError: (e: string) => void }) {
  const { t, language } = useI18n();
  const ago = agoIn(language);
  const [mode, setMode] = useState<"" | "note" | "profile">("");
  const [note, setNote] = useState("");
  const p = view.profile?.profile;
  const [fields, setFields] = useState({ displayName: "", name: "", about: "", picture: "", nip05: "", website: "" });
  const load = () => { onError(""); void engine.call("nostrLoadOwn", { subject: view.subject }).catch(e => onError(problemLine(e, t))); };
  const startProfile = () => { setFields({ displayName: p?.name ?? "", name: p?.handle ?? p?.name ?? "", about: p?.about ?? "", picture: "", nip05: p?.nip05 ?? "", website: p?.website ?? "" }); setMode("profile"); };
  const short = `${view.npub.slice(0, 12)}…${view.npub.slice(-4)}`;
  return (
    <Block testId="nostr-own">
      <div className="flex items-start gap-3">
        {p?.avatar ? <img src={p.avatar} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" /> : null}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-primary break-words" data-testid="nostr-own-name">{p?.name ?? (view.profile ? t("identities.nostr.noProfile") : t("identities.nostr.yourKey"))}</p>
          <p className="text-xs text-text-muted font-mono break-all" title={view.npub}>{short}</p>
          {view.profile && <p className="text-[11px] text-text-muted">{(() => {
            const from = { relays: view.profile.relays.map(r => r.replace(/^wss?:\/\//, "")).join(", "), time: ago(view.profile.fetchedAt) };
            return view.profile.stale ? t("identities.nostr.profileStaleFrom", from) : t("identities.nostr.profileFrom", from);
          })()}</p>}
          {view.follows && <p className="text-xs text-text-muted" data-testid="nostr-own-follows">{(() => {
            const count = view.follows.follows.length, at = view.follows.eventAt;
            if (at) return count === 1 ? t("identities.nostr.youFollowOneAsOf", { time: ago(at) }) : t("identities.nostr.youFollowAsOf", { count, time: ago(at) });
            return count === 1 ? t("identities.nostr.youFollowOne") : t("identities.nostr.youFollow", { count });
          })()}</p>}
          {view.mute && <p className="text-xs text-text-muted" data-testid="nostr-own-mute">{(() => {
            const m = view.mute, list = [
              m.pubkeys === 1 ? t("identities.nostr.keyOne") : t("identities.nostr.keys", { count: m.pubkeys }),
              m.words === 1 ? t("identities.nostr.wordOne") : t("identities.nostr.words", { count: m.words }),
              m.notes === 1 ? t("identities.nostr.noteOne") : t("identities.nostr.notes", { count: m.notes }),
            ].join(", ");
            return m.hasPrivate ? t("identities.nostr.mutePrivate", { list }) : t("identities.nostr.mute", { list });
          })()}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button data-testid="nostr-own-load" disabled={view.loading} onClick={load}>{view.loading ? t("identities.activity.loading") : view.profile ? t("identities.nostr.refresh") : t("identities.nostr.loadMine")}</Button>
        {publish && <Button data-testid="nostr-post" onClick={() => setMode(mode === "note" ? "" : "note")}>{t("identities.nostr.post")}</Button>}
        {publish && <Button data-testid="nostr-profile-edit" onClick={() => mode === "profile" ? setMode("") : startProfile()}>{t("identities.nostr.updateProfile")}</Button>}
      </div>
      {mode === "note" && (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); onPublish({ subject: view.subject, action: "note", content: note }); setMode(""); setNote(""); }}>
          <textarea data-testid="nostr-post-text" value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={4000} placeholder={t("identities.nostr.postPlaceholder")} className={input} />
          <div className="flex justify-end"><Button type="submit" variant="primary" data-testid="nostr-post-submit" disabled={!note.trim()}>{t("identities.nostr.review")}</Button></div>
        </form>
      )}
      {mode === "profile" && (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); onPublish({ subject: view.subject, action: "profile", fields: { displayName: fields.displayName, name: fields.name, about: fields.about, nip05: fields.nip05, website: fields.website, ...(fields.picture ? { picture: fields.picture } : {}) } }); setMode(""); }}>
          {!view.profile && <Notice>{t("identities.nostr.loadFirst")}</Notice>}
          <FieldGrid>
            <input data-testid="nostr-profile-name" aria-label={t("identities.nostr.name")} placeholder={t("identities.nostr.name")} maxLength={64} value={fields.displayName} onChange={e => setFields({ ...fields, displayName: e.target.value })} className={input} />
            <input data-testid="nostr-profile-handle" aria-label={t("identities.nostr.handle")} placeholder={t("identities.nostr.handle")} maxLength={64} value={fields.name} onChange={e => setFields({ ...fields, name: e.target.value })} className={input} />
            <input data-testid="nostr-profile-nip05" aria-label={t("identities.nostr.nip05")} placeholder={t("identities.nostr.nip05Placeholder")} maxLength={253} value={fields.nip05} onChange={e => setFields({ ...fields, nip05: e.target.value })} className={input} />
            <input data-testid="nostr-profile-website" aria-label={t("identities.nostr.website")} placeholder="https://…" maxLength={512} value={fields.website} onChange={e => setFields({ ...fields, website: e.target.value })} className={input} />
            <input data-testid="nostr-profile-picture" aria-label={t("identities.nostr.picture")} placeholder={t("identities.nostr.picturePlaceholder")} maxLength={2048} value={fields.picture} onChange={e => setFields({ ...fields, picture: e.target.value })} className={input} />
          </FieldGrid>
          <textarea data-testid="nostr-profile-about" aria-label={t("identities.nostr.about")} placeholder={t("identities.nostr.about")} rows={2} maxLength={500} value={fields.about} onChange={e => setFields({ ...fields, about: e.target.value })} className={input} />
          <p className="text-[11px] text-text-muted">{t("identities.nostr.fieldsNote")}</p>
          <div className="flex justify-end"><Button type="submit" variant="primary" data-testid="nostr-profile-submit">{t("identities.nostr.review")}</Button></div>
        </form>
      )}
      {view.error && <Notice tone="error" testId="nostr-own-error">{view.error}</Notice>}
    </Block>
  );
}
