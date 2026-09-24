import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { NostrContactView, NostrDraftRequest } from "@ghostly/browser/nostr/types";
import { useEngineState } from "../../lib/identities";
import { ago } from "../../lib/nostr";
import { Button, Notice } from "../wallet/ui";
import { NostrPublishDialog } from "./NostrPublishDialog";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What a contact's proven Nostr key lets the person see, each part on request: the profile (kind 0),
 * whom they follow (kind 3) with direction hints against the person's own list, and their recent notes
 * (kind 1), moderated by the person's own mute list. Every part shows where it came from and when.
 */
export function NostrContactCard({ linkId, view, name }: { linkId: string; view: NostrContactView; name: string }) {
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
  const when = (x: { fetchedAt: number; relays: string[]; stale?: boolean }) => `${x.stale ? "Stale, " : ""}from ${x.relays.map(r => r.replace(/^wss?:\/\//, "")).join(", ")} ${ago(x.fetchedAt)}`;

  return (
    <div data-testid="nostr-contact" data-subject={view.subject} className="space-y-3 text-xs text-text-muted">
      <p className="text-[11px]">Nostr, from this key. Loading asks the relays in your profile ({relays.map(r => r.replace(/^wss?:\/\//, "")).join(", ")}), which learn your IP address and that you looked this key up. Everything below is what {name} published about themselves.</p>

      {/* Profile */}
      <div className="space-y-1.5">
        {profile ? (
          <div className="flex items-start gap-3">
            {profile.avatar ? <img src={profile.avatar} alt="" data-testid="nostr-profile-avatar" className="w-12 h-12 rounded-full object-cover shrink-0" /> : <div className="w-12 h-12 rounded-full bg-surface-alt shrink-0 grid place-items-center text-text-muted" aria-hidden="true">{(profile.name ?? "?").slice(0, 1).toUpperCase()}</div>}
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm text-text-primary break-words" data-testid="nostr-profile-name">{profile.name ?? "No name"}{profile.handle && <span className="text-xs text-text-muted"> · @{profile.handle}</span>}</p>
              {profile.nip05 && <p data-testid="nostr-profile-nip05" className="break-all">{profile.nip05} <span className="text-[11px]">(NIP-05, as written by them, not checked)</span></p>}
              {profile.about && <p className="whitespace-pre-wrap break-words text-text-secondary" data-testid="nostr-profile-about">{profile.about}</p>}
              {profile.website && <a href={profile.website} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline break-all">{profile.website}</a>}
              {profile.hasPicture && !profile.avatar && <p className="text-[11px]">Their picture is on a host Ghostly does not fetch from.</p>}
            </div>
          </div>
        ) : p && !p.found ? <p data-testid="nostr-profile-none">No profile published under this key.</p> : null}
        {p && <p className="text-[11px]" data-testid="nostr-profile-source">Profile {when(p)}{profile ? `, changed by them ${ago(profile.eventAt)}` : ""}. Self-described; a manual name for this chat wins over it.</p>}
        <Button data-testid="nostr-load-profile" disabled={!!busy} onClick={() => load("profile")}>{busy === "profile" ? "Loading…" : p ? "Refresh profile" : "Load profile"}</Button>
      </div>

      {/* Social graph */}
      <div className="space-y-1.5">
        {f && <>
          <p className="text-text-primary text-sm" data-testid="nostr-follows-count">Follows {f.count} {f.count === 1 ? "account" : "accounts"}</p>
          {f.hints ? (
            <ul className="space-y-0.5" data-testid="nostr-hints">
              <li data-testid="nostr-hint-follows-you">{f.hints.followsYou ? "Follows you" : "Does not follow you"} <span className="text-[11px]">(their list names your key, or not)</span></li>
              <li data-testid="nostr-hint-you-follow">{f.hints.youFollow ? "You follow them" : "You do not follow them"} <span className="text-[11px]">(your list, loaded {ago(f.hints.myFollowsAt)})</span></li>
              <li data-testid="nostr-hint-mutual">You both follow {f.hints.mutual} {f.hints.mutual === 1 ? "account" : "accounts"}</li>
            </ul>
          ) : myKey ? <p>Load your own follow list to see who you both follow. <Button data-testid="nostr-load-own" disabled={!!busy || own.find(o => o.subject === myKey)?.loading} onClick={() => loadOwn(myKey)}>Load mine</Button></p>
            : <p className="text-[11px]">Add a Nostr identity to your profile to compare follow lists.</p>}
          <p className="text-[11px]">Follows {when(f)}; their list as of {ago(f.eventAt)}. A follow is not trust, and none of this is checked against anyone else.</p>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button data-testid="nostr-load-follows" disabled={!!busy} onClick={() => load("follows")}>{busy === "follows" ? "Loading…" : f ? "Refresh follows" : "Load follows"}</Button>
          {settings?.publish && myKey && f?.hints && (f.hints.youFollow
            ? <Button data-testid="nostr-unfollow" disabled={!!busy} onClick={() => setPublish({ subject: myKey, action: "unfollow", target: view.subject })}>Unfollow on Nostr</Button>
            : <Button data-testid="nostr-follow" disabled={!!busy} onClick={() => setPublish({ subject: myKey, action: "follow", target: view.subject })}>Follow on Nostr</Button>)}
        </div>
      </div>

      {/* Content */}
      <div className="space-y-1.5">
        {n && <>
          {n.authorMuted ? <Notice testId="nostr-notes-muted">You muted this key on Nostr: their notes stay hidden.</Notice> : n.notes.length === 0 ? <p data-testid="nostr-notes-none">No notes found.</p> : (
            <ul className="space-y-2" data-testid="nostr-notes">
              {n.notes.map(note => (
                <li key={note.id} data-testid="nostr-note" className="rounded-lg border border-border p-2 space-y-0.5">
                  <p className="text-text-primary whitespace-pre-wrap break-words">{note.content}</p>
                  <p className="text-[11px]">{ago(note.createdAt)}{note.reply ? " · a reply" : ""}</p>
                </li>
              ))}
            </ul>
          )}
          {n.hidden > 0 && <p className="text-[11px]" data-testid="nostr-notes-hidden">{n.hidden} {n.hidden === 1 ? "note" : "notes"} hidden by your mute list.</p>}
          <p className="text-[11px]">Notes {when(n)}. Newest first, as the relays hold them; no ranking.</p>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button data-testid="nostr-load-notes" disabled={!!busy} onClick={() => load("notes")}>{busy === "notes" ? "Loading…" : n ? "Refresh notes" : "Load notes"}</Button>
          {n?.more && !n.authorMuted && <Button data-testid="nostr-notes-more" disabled={!!busy} onClick={() => load("notes", true)}>Older notes</Button>}
        </div>
      </div>

      {(p || f || n) && <Button data-testid="nostr-forget" disabled={!!busy} onClick={() => void engine.call("nostrForgetContact", { linkId, subject: view.subject }).catch(e => setError(message(e)))}>Forget what was loaded</Button>}
      {(error || view.error) && <Notice tone="error" testId="nostr-contact-error">{error || view.error}</Notice>}
      {publish && <NostrPublishDialog request={publish} onClose={() => setPublish(null)} onDone={() => load("follows")} />}
    </div>
  );
}
