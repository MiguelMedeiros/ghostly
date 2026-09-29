import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { NostrContactView, NostrDraftRequest } from "@ghostly/browser/nostr/types";
import { useEngineState } from "../../lib/identities";
import { agoIn } from "../../lib/relativeTime";
import { useI18n } from "../../contexts/I18nContext";
import { Button, Notice } from "../wallet/ui";
import { NostrPublishDialog } from "./NostrPublishDialog";
import { externalLinkProps } from "../../lib/externalLink";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What a contact's proven Nostr key lets the person see, each part on request: the profile (kind 0),
 * whom they follow (kind 3) with direction hints against the person's own list, and their recent notes
 * (kind 1), moderated by the person's own mute list. Every part shows where it came from and when. `compact` (on the
 * Nostr ID card's back) says what loading reveals in one short line.
 */
export function NostrContactCard({ linkId, view, name, compact = false }: { linkId: string; view: NostrContactView; name: string; compact?: boolean }) {
  const { t, language } = useI18n();
  const ago = agoIn(language);
  const state = useEngineState();
  const settings = state?.nostr.settings;
  const own = state?.nostr.own ?? [];
  const [error, setError] = useState("");
  const [publish, setPublish] = useState<NostrDraftRequest | null>(null);
  const busy = view.loading;
  const load = (what: "profile" | "follows" | "notes", more = false) => { setError(""); void engine.call("nostrLoadContact", { linkId, subject: view.subject, what, more }).catch(e => setError(message(e))); };
  const loadOwn = (subject: string) => { setError(""); void engine.call("nostrLoadOwn", { subject }).catch(e => setError(message(e))); };
  const p = view.profile, f = view.follows, n = view.notes;
  const profile = p?.profile;
  const myKey = f?.hints?.myKey ?? own[0]?.subject;
  const relays = settings?.relays ?? [];
  const when = (x: { fetchedAt: number; relays: string[]; stale?: boolean }) => {
    const from = { relays: x.relays.map(r => r.replace(/^wss?:\/\//, "")).join(", "), time: ago(x.fetchedAt) };
    return x.stale ? t("identities.nostr.staleFrom", from) : t("identities.nostr.from", from);
  };
  const relayList = relays.map(r => r.replace(/^wss?:\/\//, "")).join(", ");

  return (
    <div data-testid="nostr-contact" data-subject={view.subject} className="space-y-3 text-xs text-text-muted">
      {compact
        ? <p className="text-[11px]" data-testid="nostr-contact-note">{t("identities.nostr.contactNoteCompact", { relays: relayList, name })}</p>
        : <p className="text-[11px]">{t("identities.nostr.contactNote", { relays: relayList, name })}</p>}

      {/* Profile */}
      <div className="space-y-1.5">
        {profile ? (
          <div className="flex items-start gap-3">
            {profile.avatar ? <img src={profile.avatar} alt="" data-testid="nostr-profile-avatar" className="w-12 h-12 rounded-full object-cover shrink-0" /> : <div className="w-12 h-12 rounded-full bg-surface-alt shrink-0 grid place-items-center text-text-muted" aria-hidden="true">{(profile.name ?? "?").slice(0, 1).toUpperCase()}</div>}
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm text-text-primary break-words" data-testid="nostr-profile-name">{profile.name ?? t("identities.nostr.noName")}{profile.handle && <span className="text-xs text-text-muted"> · @{profile.handle}</span>}</p>
              {profile.nip05 && <p data-testid="nostr-profile-nip05" className="break-all">{profile.nip05} <span className="text-[11px]">{t("identities.nostr.nip05Unchecked")}</span></p>}
              {profile.about && <p className="whitespace-pre-wrap break-words text-text-secondary" data-testid="nostr-profile-about">{profile.about}</p>}
              {profile.website && <a {...externalLinkProps(profile.website)} rel="noopener noreferrer nofollow" className="text-accent underline break-all">{profile.website}</a>}
              {profile.hasPicture && !profile.avatar && <p className="text-[11px]">{t("identities.nostr.pictureHost")}</p>}
            </div>
          </div>
        ) : p && !p.found ? <p data-testid="nostr-profile-none">{t("identities.nostr.profileNone")}</p> : null}
        {p && <p className="text-[11px]" data-testid="nostr-profile-source">{profile ? t("identities.nostr.profileSourceChanged", { when: when(p), time: ago(profile.eventAt) }) : t("identities.nostr.profileSource", { when: when(p) })}</p>}
        <Button data-testid="nostr-load-profile" disabled={!!busy} onClick={() => load("profile")}>{busy === "profile" ? t("identities.activity.loading") : p ? t("identities.nostr.refreshProfile") : t("identities.nostr.loadProfile")}</Button>
      </div>

      {/* Social graph */}
      <div className="space-y-1.5">
        {f && <>
          <p className="text-text-primary text-sm" data-testid="nostr-follows-count">{f.count === 1 ? t("identities.nostr.followsOne") : t("identities.nostr.follows", { count: f.count })}</p>
          {f.hints ? (
            <ul className="space-y-0.5" data-testid="nostr-hints">
              <li data-testid="nostr-hint-follows-you">{f.hints.followsYou ? t("identities.activity.followsYou") : t("identities.nostr.notFollowsYou")} <span className="text-[11px]">{t("identities.nostr.followsYouHint")}</span></li>
              <li data-testid="nostr-hint-you-follow">{f.hints.youFollow ? t("identities.nostr.youFollowThem") : t("identities.nostr.notYouFollowThem")} <span className="text-[11px]">{t("identities.nostr.yourListLoaded", { time: ago(f.hints.myFollowsAt) })}</span></li>
              <li data-testid="nostr-hint-mutual">{f.hints.mutual === 1 ? t("identities.nostr.mutualOne") : t("identities.nostr.mutual", { count: f.hints.mutual })}</li>
            </ul>
          ) : myKey ? <p>{t("identities.nostr.loadOwnHint")} <Button data-testid="nostr-load-own" disabled={!!busy || own.find(o => o.subject === myKey)?.loading} onClick={() => loadOwn(myKey)}>{t("identities.nostr.loadMineShort")}</Button></p>
            : <p className="text-[11px]">{t("identities.nostr.addToCompare")}</p>}
          <p className="text-[11px]">{t("identities.nostr.followsSource", { when: when(f), time: ago(f.eventAt) })}</p>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button data-testid="nostr-load-follows" disabled={!!busy} onClick={() => load("follows")}>{busy === "follows" ? t("identities.activity.loading") : f ? t("identities.nostr.refreshFollows") : t("identities.nostr.loadFollows")}</Button>
          {settings?.publish && myKey && f?.hints && (f.hints.youFollow
            ? <Button data-testid="nostr-unfollow" disabled={!!busy} onClick={() => setPublish({ subject: myKey, action: "unfollow", target: view.subject })}>{t("identities.nostr.unfollow")}</Button>
            : <Button data-testid="nostr-follow" disabled={!!busy} onClick={() => setPublish({ subject: myKey, action: "follow", target: view.subject })}>{t("identities.nostr.follow")}</Button>)}
        </div>
      </div>

      {/* Content */}
      <div className="space-y-1.5">
        {n && <>
          {n.authorMuted ? <Notice testId="nostr-notes-muted">{t("identities.nostr.muted")}</Notice> : n.notes.length === 0 ? <p data-testid="nostr-notes-none">{t("identities.nostr.notesNone")}</p> : (
            <ul className="space-y-2" data-testid="nostr-notes">
              {n.notes.map(note => (
                <li key={note.id} data-testid="nostr-note" className="rounded-lg border border-border p-2 space-y-0.5">
                  <p className="text-text-primary whitespace-pre-wrap break-words">{note.content}</p>
                  <p className="text-[11px]">{ago(note.createdAt)}{note.reply ? ` · ${t("identities.nostr.aReply")}` : ""}</p>
                </li>
              ))}
            </ul>
          )}
          {n.hidden > 0 && <p className="text-[11px]" data-testid="nostr-notes-hidden">{n.hidden === 1 ? t("identities.nostr.hiddenOne") : t("identities.nostr.hidden", { count: n.hidden })}</p>}
          <p className="text-[11px]">{t("identities.nostr.notesSource", { when: when(n) })}</p>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button data-testid="nostr-load-notes" disabled={!!busy} onClick={() => load("notes")}>{busy === "notes" ? t("identities.activity.loading") : n ? t("identities.nostr.refreshNotes") : t("identities.nostr.loadNotes")}</Button>
          {n?.more && !n.authorMuted && <Button data-testid="nostr-notes-more" disabled={!!busy} onClick={() => load("notes", true)}>{t("identities.nostr.olderNotes")}</Button>}
        </div>
      </div>

      {(p || f || n) && <Button data-testid="nostr-forget" disabled={!!busy} onClick={() => void engine.call("nostrForgetContact", { linkId, subject: view.subject }).catch(e => setError(message(e)))}>{t("identities.nostr.forget")}</Button>}
      {(error || view.error) && <Notice tone="error" testId="nostr-contact-error">{error || view.error}</Notice>}
      {publish && <NostrPublishDialog request={publish} onClose={() => setPublish(null)} onDone={() => load("follows")} />}
    </div>
  );
}
