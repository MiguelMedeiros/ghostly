import type { IdentityTimelineEntry } from "@ghostly/core";
import { IDENTITY_CHALLENGE_WINDOW } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { focus } from "../../lib/connection";
import { providerLabel, shortSubject, useEngineState } from "../../lib/identities";
import { idCard, receivedIdCard } from "./idCard";
import { ProviderMark } from "./ProviderMark";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Where a share stands, as the card's corner shows it. `waiting`: mine, the contact not connected yet. `unanswered`: theirs, never presented. */
type ShareMark = "verifying" | "verified" | "failed" | "waiting" | "unanswered";
const MARK_TEXT: Record<ShareMark, string> = { verifying: "Checking", verified: "Verified", failed: "Not verified", waiting: "Waiting", unanswered: "Not checked" };

/** The mark a share wears now: its entry's state, told apart where the entry alone cannot say it. */
function shareMark(entry: IdentityTimelineEntry, link: Pick<LinkView, "identities"> | undefined, now = Date.now()): ShareMark {
  if (entry.state === "verified" || entry.state === "failed") return entry.state;
  if (entry.side === "mine") return link?.identities?.shared.find(s => s.id === entry.proof)?.status === "queued" ? "waiting" : "verifying";
  // The contact asked for a challenge and never answered it: it can no longer be answered.
  return now - entry.at > IDENTITY_CHALLENGE_WINDOW * 1000 ? "unanswered" : "verifying";
}

/** The identity as the card shows it: its picture and name when known (a public profile, #297), else its provider's mark and handle. */
function useShown(entry: IdentityTimelineEntry, link: LinkView | undefined) {
  const state = useEngineState();
  const now = Date.now() / 1000;
  const r = entry.side === "theirs" ? link?.identities?.received.find(x => x.id === entry.proof) : undefined;
  const p = entry.side === "mine" ? state?.identityProofs?.find(x => x.id === entry.proof) : undefined;
  const card = r ? receivedIdCard(r, now) : p ? idCard(p, { now }) : undefined;
  const subject = card?.subject ?? entry.subject;
  return {
    label: card?.label ?? providerLabel(entry.provider),
    short: card?.short ?? (subject ? shortSubject(entry.provider, subject) : undefined),
    bound: card?.bound ?? entry.subject,
    // A stopped share never wears what the account says about itself (idCard.ts's rule for a withdrawn card).
    name: entry.kind === "shared" ? card?.name : undefined,
    photo: entry.kind === "shared" ? card?.photo : undefined,
  };
}

/**
 * An identity shared in the chat, as its timeline shows it: a small ID card, centred like the transport lines,
 * for both sides ("You shared Nostr", "Ana shared Nostr"). The picture and name when the identity has them, the
 * provider's mark and the handle, and a mark in the corner that turns from checking to verified (or not). A stop is
 * a line. Local only: not a message, never sent, never unread. Tapping it opens the chat's identities on that card.
 */
export function IdentityShareLine({ entry, link, contact, onOpen }: { entry: IdentityTimelineEntry; link: LinkView | undefined; contact: string; onOpen: (entry: IdentityTimelineEntry) => void }) {
  const shown = useShown(entry, link);
  const who = entry.side === "mine" ? "You" : contact;
  const what = `${shown.label}${shown.short ? ` · ${shown.short}` : ""}`;
  if (entry.kind === "stopped") {
    const text = entry.reason === "revoked"
      ? `${entry.side === "mine" ? "Your" : `${contact}’s`} ${what} was revoked`
      : `${who} stopped sharing ${what}`;
    return (
      <div className="mb-3.5 flex flex-col items-center px-[63px] max-md:px-2.5" data-testid="identity-share" data-side={entry.side} data-kind="stopped">
        <button type="button" onClick={() => onOpen(entry)}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface-alt/80 px-3 py-1.5 text-start text-xs text-text-secondary transition-colors hover:bg-surface-hover ${focus}`}>
          <span className="opacity-60 grayscale"><ProviderMark provider={entry.provider} subject={shown.bound} small /></span>
          <span className="min-w-0 break-words" data-testid="identity-share-text">{text}</span>
          <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 text-[10px] text-text-muted">{time(entry.at)}</time>
        </button>
      </div>
    );
  }
  const mark = shareMark(entry, link);
  const title = mark === "failed" && entry.error ? `${MARK_TEXT.failed}: ${entry.error}` : MARK_TEXT[mark];
  return (
    <div className="mb-3.5 flex flex-col items-center px-[63px] max-md:px-2.5" data-testid="identity-share" data-side={entry.side} data-kind="shared" data-state={mark}>
      <button type="button" onClick={() => onOpen(entry)} aria-label={`${who} shared ${what} · ${title}`}
        className={`flex w-full max-w-[280px] items-center gap-2.5 rounded-xl border border-border bg-surface-alt/90 p-2.5 text-start shadow-sm transition-colors hover:bg-surface-hover ${focus}`}>
        <span className="relative shrink-0">
          {shown.photo
            ? <>
              <img src={shown.photo} alt="" width={40} height={40} decoding="async" draggable={false} className="h-10 w-10 rounded-xl object-cover" data-testid="identity-share-photo" />
              <span className="absolute -bottom-1 -end-1 rounded-md ring-2 ring-surface-alt"><ProviderMark provider={entry.provider} subject={shown.bound} small /></span>
            </>
            : <ProviderMark provider={entry.provider} subject={shown.bound} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-[11px] text-text-muted">
            <span className="min-w-0 truncate" data-testid="identity-share-text">{who} shared {shown.label}</span>
            <time dateTime={new Date(entry.at).toISOString()} className="ms-auto shrink-0 text-[10px]">{time(entry.at)}</time>
          </span>
          {shown.name && <span className="block truncate text-sm font-medium text-text-primary" data-testid="identity-share-name">{shown.name}</span>}
          <span className={`block truncate ${shown.name ? "text-xs text-text-secondary" : "text-sm font-medium text-text-primary"}`} data-testid="identity-share-subject" title={entry.subject}>{shown.short ?? "…"}</span>
        </span>
        <ShareMarkIcon mark={mark} title={title} />
      </button>
    </div>
  );
}

function ShareMarkIcon({ mark, title }: { mark: ShareMark; title: string }) {
  const tone = mark === "verified" ? "bg-accent text-on-accent" : mark === "failed" ? "bg-danger/15 text-danger-ink" : "bg-text-muted/15 text-text-muted";
  return (
    <span role="img" aria-label={title} title={title} data-testid="identity-share-state" data-state={mark}
      className={`grid h-6 w-6 shrink-0 place-items-center self-center rounded-full ${tone}`}>
      {mark === "verifying"
        ? <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" className="animate-spin motion-reduce:animate-none"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        : <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          {mark === "verified" ? <path d="m3 8.5 3 3 7-7" /> : mark === "failed" ? <path d="M8 3.5v5.5M8 12.2v.3" /> : <><circle cx="8" cy="8" r="5.5" strokeWidth="1.8" /><path d="M8 5v3.2l2 1.3" strokeWidth="1.8" /></>}
        </svg>}
    </span>
  );
}
